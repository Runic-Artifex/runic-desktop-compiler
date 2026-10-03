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
declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
interface ImportMeta {
  url: string;
}
