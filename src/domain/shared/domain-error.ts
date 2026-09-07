/**
 * Base class for every error that represents a violation of a domain rule.
 * Infrastructure/transport errors must NOT extend this.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a value object receives structurally invalid input. */
export class InvalidValueError extends DomainError {
  readonly code = 'INVALID_VALUE';
}
