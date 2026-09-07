import { uuidv7 } from 'uuidv7';

export abstract class IdGenerator {
  abstract next(): string;
}

export class Uuidv7Generator extends IdGenerator {
  next(): string {
    return uuidv7();
  }
}
