/// <reference types="https://deno.land/x/deno_types/1.43.1/lib.deno.ns.d.ts" />

declare namespace Deno {
  export function serve(handler: (req: Request) => Promise<Response>): void;
  export const env: {
    get(key: string): string | undefined;
  };
}