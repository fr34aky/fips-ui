// The one GitHub request fips-ui makes unauthenticated: a repository's newest release. The self-update check and
// the public-domains install share it, so the token, the timeout and the rate-limit hint live here once.
export interface GhRelease { tag_name?: string; html_url?: string; published_at?: string; body?: string }

export async function fetchLatestRelease(repo: string): Promise<GhRelease> {
  const headers: Record<string, string> = { 'user-agent': 'fips-ui', accept: 'application/vnd.github+json' };
  if (process.env.FIPS_UI_GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.FIPS_UI_GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}${r.status === 403 ? ' (rate limit? set FIPS_UI_GITHUB_TOKEN)' : ''}`);
  return r.json() as Promise<GhRelease>;
}
