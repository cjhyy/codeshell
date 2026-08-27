import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import type {
  ReviewGitCommit,
  ReviewGitDiffRequest,
  ReviewGitDiffResult,
  ReviewGitStatusResult,
  ReviewRepositoryError,
  ReviewRepositoryIdentity,
} from "../shared/review.js";
import {
  getGitBranchBase,
  getGitDiffForReview,
  getGitRecentCommits,
  getGitRangeDiff,
  getGitRepositoryRoot,
  getGitStatusForReview,
  type GitCommit,
  type GitDiffMode,
  type GitStatus,
} from "./desktop-services.js";
import { resolveSessionReviewWorkspaceForUi } from "./session-workspace-service.js";

export interface ReviewWorkspace {
  projectId: string | null;
  mainRootId: string;
  roots: Array<{ id: string; path: string; role: "primary" | "secondary" }>;
}

interface ReviewRepository extends ReviewRepositoryIdentity {
  key: string;
}

interface ReviewRepositoryResolution {
  repositories: ReviewRepository[];
  errors: ReviewRepositoryError[];
}

export interface ReviewServiceDependencies {
  resolveWorkspace(sessionId: string): Promise<ReviewWorkspace>;
  resolveGitTopLevel?(rootPath: string): Promise<string | null>;
  getGitStatus?(repoRoot: string): Promise<GitStatus>;
  getGitDiff?(repoRoot: string, file: undefined, mode: GitDiffMode): Promise<string>;
  getGitRangeDiff?(repoRoot: string, range: string): Promise<string>;
  getGitBranchBase?(repoRoot: string): Promise<string>;
  getGitRecentCommits?(repoRoot: string, limit?: number): Promise<GitCommit[]>;
}

export class ReviewService {
  private readonly resolveWorkspace: ReviewServiceDependencies["resolveWorkspace"];
  private readonly resolveGitTopLevel: NonNullable<ReviewServiceDependencies["resolveGitTopLevel"]>;
  private readonly statusForRepository: NonNullable<ReviewServiceDependencies["getGitStatus"]>;
  private readonly diffForRepository: NonNullable<ReviewServiceDependencies["getGitDiff"]>;
  private readonly rangeDiffForRepository: NonNullable<
    ReviewServiceDependencies["getGitRangeDiff"]
  >;
  private readonly branchBaseForRepository: NonNullable<
    ReviewServiceDependencies["getGitBranchBase"]
  >;
  private readonly commitsForRepository: NonNullable<
    ReviewServiceDependencies["getGitRecentCommits"]
  >;

  constructor(deps: ReviewServiceDependencies) {
    this.resolveWorkspace = deps.resolveWorkspace;
    this.resolveGitTopLevel = deps.resolveGitTopLevel ?? getGitRepositoryRoot;
    this.statusForRepository = deps.getGitStatus ?? getGitStatusForReview;
    this.diffForRepository =
      deps.getGitDiff ?? ((cwd, _file, mode) => getGitDiffForReview(cwd, mode));
    this.rangeDiffForRepository = deps.getGitRangeDiff ?? getGitRangeDiff;
    this.branchBaseForRepository = deps.getGitBranchBase ?? getGitBranchBase;
    this.commitsForRepository = deps.getGitRecentCommits ?? getGitRecentCommits;
  }

  async getStatus(sessionId: string): Promise<ReviewGitStatusResult> {
    const resolved = await this.resolveRepositories(sessionId);
    const outcomes = await Promise.all(
      resolved.repositories.map(async (repository) => {
        try {
          const status = await this.statusForRepository(repository.repoRoot);
          return {
            repository: {
              ...identity(repository),
              branch: status.branch,
              clean: status.clean,
              entries: status.entries.map((entry) => ({
                ...entry,
                rootId: repository.rootId,
                repoRoot: repository.repoRoot,
              })),
            },
          };
        } catch (error) {
          return { error: repositoryError("status", repository, error) };
        }
      }),
    );
    return {
      repositories: outcomes.flatMap((outcome) => (outcome.repository ? [outcome.repository] : [])),
      errors: sortErrors([
        ...resolved.errors,
        ...outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : [])),
      ]),
    };
  }

  async getDiff(sessionId: string, request: ReviewGitDiffRequest): Promise<ReviewGitDiffResult> {
    validateDiffRequest(request);
    const resolved = await this.resolveRepositories(sessionId);
    const repositories = selectRepositories(resolved.repositories, request);
    const outcomes = await Promise.all(
      repositories.map(async (repository) => {
        try {
          const diff = await this.diffRepository(repository, request);
          return { repository: { ...identity(repository), diff } };
        } catch (error) {
          return { error: repositoryError("diff", repository, error) };
        }
      }),
    );
    return {
      repositories: outcomes.flatMap((outcome) => (outcome.repository ? [outcome.repository] : [])),
      errors: sortErrors([
        ...resolved.errors,
        ...outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : [])),
      ]),
    };
  }

  async getRecentCommits(sessionId: string, limit?: number): Promise<ReviewGitCommit[]> {
    const resolved = await this.resolveRepositories(sessionId);
    const boundedLimit =
      typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0
        ? Math.min(limit, 100)
        : undefined;
    const outcomes = await Promise.all(
      resolved.repositories.map(async (repository) => {
        try {
          const commits = await this.commitsForRepository(repository.repoRoot, boundedLimit);
          return commits.map((commit) => ({ ...identity(repository), ...commit }));
        } catch {
          return [];
        }
      }),
    );
    return outcomes.flat();
  }

  private async diffRepository(
    repository: ReviewRepository,
    request: ReviewGitDiffRequest,
  ): Promise<string> {
    if (request.kind === "working") {
      return this.diffForRepository(repository.repoRoot, undefined, request.mode);
    }
    if (request.kind === "committed") {
      const range = request.commitHash
        ? `${request.commitHash}^..${request.commitHash}`
        : "HEAD~1..HEAD";
      return this.rangeDiffForRepository(repository.repoRoot, range);
    }
    const base = await this.branchBaseForRepository(repository.repoRoot);
    return this.rangeDiffForRepository(
      repository.repoRoot,
      base ? `${base}...HEAD` : "HEAD~1..HEAD",
    );
  }

  private async resolveRepositories(sessionId: string): Promise<ReviewRepositoryResolution> {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Review requires a Session");
    const workspace = await this.resolveWorkspace(sessionId);
    const discoveries = await Promise.all(
      workspace.roots.map(async (root) => {
        try {
          return { root, repoRoot: await this.resolveGitTopLevel(root.path) };
        } catch (error) {
          return { root, error };
        }
      }),
    );
    const byKey = new Map<
      string,
      { repoRoot: string; roots: Array<{ id: string; path: string }> }
    >();
    const errors: ReviewRepositoryError[] = [];
    for (const discovery of discoveries) {
      if (discovery.error) {
        errors.push({
          operation: "discover",
          rootId: discovery.root.id,
          rootIds: [discovery.root.id],
          rootPath: discovery.root.path,
          message: errorMessage(discovery.error),
        });
        continue;
      }
      if (!discovery.repoRoot) continue;
      const key = canonicalKey(discovery.repoRoot);
      const current = byKey.get(key);
      if (current) current.roots.push(discovery.root);
      else byKey.set(key, { repoRoot: discovery.repoRoot, roots: [discovery.root] });
    }

    const repositories = [...byKey.entries()].map(([key, value]) => {
      const ids = value.roots
        .map((root) => root.id)
        .sort((left, right) => left.localeCompare(right));
      const rootIds = ids.includes(workspace.mainRootId)
        ? [workspace.mainRootId, ...ids.filter((id) => id !== workspace.mainRootId)]
        : ids;
      return {
        key,
        repoRoot: value.repoRoot,
        rootId: rootIds[0]!,
        rootIds,
      };
    });
    repositories.sort(
      (left, right) => left.key.localeCompare(right.key) || left.rootId.localeCompare(right.rootId),
    );
    return { repositories, errors: sortErrors(errors) };
  }
}

function identity(repository: ReviewRepository): ReviewRepositoryIdentity {
  return {
    rootId: repository.rootId,
    rootIds: [...repository.rootIds],
    repoRoot: repository.repoRoot,
  };
}

function validateDiffRequest(request: ReviewGitDiffRequest): void {
  if (!request || typeof request !== "object") throw new Error("invalid Review diff request");
  if (request.kind === "working") {
    if (!(["unstaged", "staged", "all"] as const).includes(request.mode)) {
      throw new Error("invalid Review diff mode");
    }
    return;
  }
  if (request.kind === "branch") return;
  if (request.kind !== "committed") throw new Error("invalid Review diff kind");
  if (
    request.rootId !== undefined &&
    (typeof request.rootId !== "string" || !request.rootId || request.rootId.length > 512)
  ) {
    throw new Error("invalid Review root id");
  }
  if (
    request.commitHash !== undefined &&
    (typeof request.commitHash !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(request.commitHash))
  ) {
    throw new Error("invalid Review commit hash");
  }
  if ((request.rootId === undefined) !== (request.commitHash === undefined)) {
    throw new Error("Review commit selection requires both root id and commit hash");
  }
}

function selectRepositories(
  repositories: ReviewRepository[],
  request: ReviewGitDiffRequest,
): ReviewRepository[] {
  if (request.kind !== "committed" || request.rootId === undefined) return repositories;
  const selected = repositories.find((repository) => repository.rootIds.includes(request.rootId!));
  if (!selected) throw new Error("Review root is not part of the authoritative Session workspace");
  return [selected];
}

function repositoryError(
  operation: ReviewRepositoryError["operation"],
  repository: ReviewRepository,
  error: unknown,
): ReviewRepositoryError {
  return { operation, ...identity(repository), message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sortErrors(errors: ReviewRepositoryError[]): ReviewRepositoryError[] {
  return errors.sort(
    (left, right) =>
      (left.repoRoot ?? left.rootPath ?? "").localeCompare(
        right.repoRoot ?? right.rootPath ?? "",
      ) || left.rootId.localeCompare(right.rootId),
  );
}

export const reviewService = new ReviewService({
  resolveWorkspace: resolveSessionReviewWorkspaceForUi,
});
