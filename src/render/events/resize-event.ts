/**
 * ResizeEvent — fired when the terminal is resized.
 */

import { TerminalEvent } from './terminal-event.js';

export class ResizeEvent extends TerminalEvent {
  readonly columns: number;
  readonly rows: number;

  constructor(columns: number, rows: number) {
    super('resize');
    this.columns = columns;
    this.rows = rows;
  }
}
