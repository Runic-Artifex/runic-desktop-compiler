// The Node built-ins the frontend uses (the repository does not install @types/node).
declare module 'node:path' {
  const path: {
    sep: string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    relative(from: string, to: string): string;
    dirname(p: string): string;
    basename(p: string, ext?: string): string;
    extname(p: string): string;
    isAbsolute(p: string): boolean;
  };
  export default path;
}
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): { name: string; isDirectory(): boolean; isFile(): boolean }[];
}
declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string | Uint8Array): { digest(encoding: 'hex'): string };
  };
}
declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown;
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
interface ImportMeta {
  url: string;
}
declare module 'node:os' {
  export function platform(): string;
}
