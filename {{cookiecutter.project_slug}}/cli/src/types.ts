// Shared shapes. Commands only ever see these two things: their own argv
// tail and the exit code they hand back to the process.

/** A single CLI verb. `run` returns the process exit code — it never calls
 * `process.exit` itself, so commands stay testable as plain functions. */
export interface CliCommand {
  /** The word typed after the CLI's own name, e.g. "status". */
  name: string;
  /** One line, shown in `--help` next to the name. */
  summary: string;
  /** Everything after the command name on argv. */
  run(args: string[]): Promise<number>;
}
