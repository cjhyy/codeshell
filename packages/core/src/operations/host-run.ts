import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { EncryptionCipher } from "../credentials/cipher.js";
import {
  OperationLedger,
  canonicalOperationValue,
  type OperationPlan,
  type OperationError,
  type OperationReference,
  type OperationConflictScopeResolver,
} from "./ledger.js";
import { digest } from "./schema.js";
import { readOperationSessionOwner } from "./session-owner.js";
import type { OperationLedgerRequest } from "./host-transport.js";

/** One trusted executor Run. Only receipts issued to this instance may be mutated. */
export class ScopedRunLedger {
  private readonly ids = new Set<string>();
  private readonly ledger: OperationLedger;
  private commit?: () => void;
  constructor(
    root: string,
    private readonly sessionId: string,
    readonly runId: string,
    cipher: EncryptionCipher,
    initialKey: string | undefined,
    resolver: OperationConflictScopeResolver,
    private readonly ephemeral = false,
  ) {
    const read = () => {
      const owner = readOperationSessionOwner(root, sessionId);
      if (owner.state.runId !== runId || owner.state.status !== "active")
        throw new Error("Operation Run changed");
      return owner;
    };
    this.ledger = new OperationLedger(
      root,
      cipher,
      ephemeral ? undefined : { sessionId, read },
      initialKey,
      () => {
        if (!this.commit) throw new Error("Operation Run ended");
        if (ephemeral) {
          // The trusted executor owns process-local sessions. It cannot substitute a process-local
          // ledger grant for any persisted identity, including a replaced directory or broken link.
          const dir = join(root, sessionId);
          const info = lstatSync(dir, { throwIfNoEntry: false });
          if (
            info &&
            (!info.isDirectory() ||
              info.isSymbolicLink() ||
              lstatSync(join(dir, "state.json"), { throwIfNoEntry: false }))
          )
            throw new Error("Operation Session is durable");
        } else read();
        this.commit();
      },
    );
    this.ledger.setConflictScopeResolver("github", resolver);
  }
  run(request: OperationLedgerRequest, commit: () => void) {
    const { method, args } = request;
    if (
      request.runId !== this.runId ||
      request.sessionId !== this.sessionId ||
      !!request.ephemeral !== this.ephemeral
    )
      throw new Error("Operation Run changed");
    canonicalOperationValue(args, 512 * 1024);
    const plan = (input: unknown): OperationPlan => {
      const p = input as OperationPlan;
      if (
        !p ||
        p.sessionId !== this.sessionId ||
        p.service !== "github" ||
        !["local-link", "remote-link"].includes(p.channel) ||
        !["create_issue", "set_starred", "update_issue"].includes(p.action)
      )
        throw new Error("Invalid Link operation");
      return p;
    };
    const issued = (input: unknown) => {
      const id = digest.parse(input);
      if (!this.ids.has(id)) throw new Error("Operation receipt unavailable");
      return id;
    };
    this.commit = commit;
    try {
      switch (method) {
        case "prepare": {
          if (args.length !== 1 || this.ids.size >= 10000) break;
          const receipt = this.ledger.prepare(plan(args[0]));
          this.ids.add(receipt.id);
          return receipt;
        }
        case "claim":
          if (args.length < 1 || args.length > 2) break;
          return this.ledger.claim(
            issued(args[0]),
            args[1] == null ? undefined : digest.parse(args[1]),
          );
        case "settle": {
          const [id, attempt, status, opts] = args;
          if (
            args.length !== 4 ||
            !(attempt == null || typeof attempt === "string") ||
            !(
              status === "blocked" ||
              status === "succeeded" ||
              status === "verified" ||
              status === "unknown"
            ) ||
            !opts ||
            typeof opts !== "object" ||
            Array.isArray(opts) ||
            Object.keys(opts).some((k) => k !== "reference" && k !== "error")
          )
            break;
          return this.ledger.settle(
            issued(id),
            attempt ?? undefined,
            status,
            opts as { reference?: OperationReference; error?: OperationError },
          );
        }
        case "sealPending":
          if (args.length === 1) return this.ledger.sealPending(issued(args[0]));
          break;
        case "captureRecovery":
          if (args.length !== 4 || (args[2] !== "prepared" && args[2] !== "identity")) break;
          this.ledger.captureRecovery(plan(args[0]), issued(args[1]), args[2], args[3]);
          return true;
        case "hasUnverifiedWrites":
        case "sealForFinalization":
          if (args.length === 1 && args[0] === this.sessionId)
            return this.ledger[method](this.sessionId);
          break;
      }
      throw new Error("Invalid operation arguments");
    } finally {
      this.commit = undefined;
    }
  }
}
