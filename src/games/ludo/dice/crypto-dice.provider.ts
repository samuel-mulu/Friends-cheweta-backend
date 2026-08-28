import { randomInt } from 'node:crypto';
import { DiceProvider } from './dice-provider';

export class CryptoDiceProvider implements DiceProvider {
  roll(): number {
    return randomInt(1, 7);
  }
}
