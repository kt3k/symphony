export type EnvLookup = (name: string) => string | undefined;

export const denoEnv: EnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const VAR_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function envReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = VAR_REF.exec(value.trim());
  return match ? match[1] : null;
}

export function resolveEnvValue(value: unknown, env: EnvLookup): unknown {
  const ref = envReference(value);
  if (ref === null) return value;
  const resolved = env(ref);
  return resolved === undefined || resolved === "" ? undefined : resolved;
}
