/**
 * Errors that are shown to people (and to their agent) in plain language.
 * `message` says what went wrong; `hint` says what to do about it.
 */
export class RemakeError extends Error {
  readonly hint?: string;
  readonly code: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "RemakeError";
    this.code = code;
    this.hint = hint;
  }

  toString(): string {
    return this.hint ? `${this.message}\n→ ${this.hint}` : this.message;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof RemakeError) return err.toString();
  if (err instanceof Error) return err.message;
  return String(err);
}
