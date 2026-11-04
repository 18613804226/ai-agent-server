import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          webpreferences?: string;
          allowpopups?: boolean | string;
        },
        HTMLElement
      >;
    }
  }
}
