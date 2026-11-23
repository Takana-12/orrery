// A refusal the caller caused or can act on. `status` is the HTTP status the interface layer answers with;
// the message is shown to the human as it is.
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
