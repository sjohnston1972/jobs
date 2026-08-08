// Markdown is pulled in as a string via the Wrangler `Text` rule in wrangler.toml.
declare module '*.md' {
  const content: string;
  export default content;
}
