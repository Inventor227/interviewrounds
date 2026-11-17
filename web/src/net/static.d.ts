// Content versions of the big public files, made at build time by staticVersions.ts.
declare module 'virtual:ir-static' {
  const files: Record<string, { v: string; bytes: number }>;
  export default files;
}
