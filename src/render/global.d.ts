/**
 * JSX intrinsic element declarations for the custom ink reconciler.
 * These map to the host component types created in reconciler.ts / dom.ts.
 */

import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': any;
      'ink-text': any;
      'ink-virtual-text': any;
      'ink-link': any;
      'ink-raw-ansi': any;
      'ink-progress': any;
    }
  }
}
