/**
 * PasteEvent — fired when bracketed paste data arrives from the terminal.
 */

import { TerminalEvent } from './terminal-event.js';

export class PasteEvent extends TerminalEvent {
  readonly text: string;

  constructor(text: string) {
    super('paste');
    this.text = text;
  }
}
