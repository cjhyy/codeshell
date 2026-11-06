/** Per-phase timing for one Mimi chat turn's main-process preparation. */
export interface PetTurnTimer {
  phase<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  done(): void;
}

export function createPetTurnTimer(options: {
  clientMessageId: string | undefined;
  now?: () => number;
  log: (msg: string, data?: Record<string, unknown>) => void;
}): PetTurnTimer {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const base = { clientMessageId: options.clientMessageId };
  return {
    async phase(name, run) {
      const begin = now();
      try {
        const value = await run();
        options.log("pet.turn.phase", { ...base, phase: name, ms: Math.round(now() - begin) });
        return value;
      } catch (error) {
        options.log("pet.turn.phase", {
          ...base,
          phase: name,
          ms: Math.round(now() - begin),
          ok: false,
        });
        throw error;
      }
    },
    done() {
      options.log("pet.turn.prep_total", { ...base, ms: Math.round(now() - startedAt) });
    },
  };
}
