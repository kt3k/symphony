/** Environment lookup abstraction so config resolution is testable without touching Deno.env. */
export type EnvLookup = (name: string) => string | undefined;

export const denoEnv: EnvLookup = (name) => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
};

const VAR_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/** Returns the variable name when `value` is exactly `$VAR_NAME`, else null (§6.1). */
export function envReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = VAR_REF.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Resolves `$VAR_NAME` indirection for one config value. Non-reference values are returned as-is.
 * Missing or empty variables resolve to `undefined` so callers can treat secrets as missing.
 */
export function resolveEnvValue(value: unknown, env: EnvLookup): unknown {
  const ref = envReference(value);
  if (ref === null) return value;
  const resolved = env(ref);
  return resolved === undefined || resolved === "" ? undefined : resolved;
}
