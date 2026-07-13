import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LocalPetMetadata {
  version: 1;
  owner: "local-user";
  petId: "local-pet";
  petSessionId: string;
  createdAt: number;
}

export class PetMetadataStore {
  private current: Promise<LocalPetMetadata> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly options: {
      now?: () => number;
      createSessionId?: () => string;
    } = {},
  ) {}

  ensure(): Promise<LocalPetMetadata> {
    this.current ??= this.loadOrCreate();
    return this.current;
  }

  private async loadOrCreate(): Promise<LocalPetMetadata> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<LocalPetMetadata>;
      if (
        parsed.version === 1 &&
        parsed.owner === "local-user" &&
        parsed.petId === "local-pet" &&
        typeof parsed.petSessionId === "string" &&
        parsed.petSessionId.startsWith("pet-") &&
        typeof parsed.createdAt === "number"
      ) {
        return parsed as LocalPetMetadata;
      }
      throw new Error("invalid local pet metadata");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      }
    }

    const metadata: LocalPetMetadata = {
      version: 1,
      owner: "local-user",
      petId: "local-pet",
      petSessionId: this.options.createSessionId?.() ?? `pet-${randomUUID()}`,
      createdAt: (this.options.now ?? Date.now)(),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
    return metadata;
  }
}
