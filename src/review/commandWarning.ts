/**
 * Identifies clearly destructive shell command patterns for the approval prompt.
 */
export function getDestructiveWarning(command: string): string | undefined {
  if (!command) return undefined;
  const trimmed = command.trim();

  // Piping a download into a shell interpreter
  if (/(?:^|[;&|]\s*)(?:[a-zA-Z0-9_-]+=[^\s]+\s+)*(?:curl|wget|fetch|Invoke-WebRequest|iwr)\b[^|;&\n]*\|\s*(?:(?:(?:\/usr)?(?:\/local)?\/bin\/)?(?:bash|sh|zsh|dash|ksh)|powershell(?:(?:\.exe)?)|pwsh(?:(?:\.exe)?)|cmd(?:(?:\.exe)?)|iex|Invoke-Expression)\b/i.test(trimmed)) {
    return 'Pipes downloaded content directly into a shell interpreter';
  }

  // Recursive or forced file deletion (rm -rf, rmdir /s, del /s, Remove-Item -Recurse)
  if (/(?:^|[;&|]\s*)(?:[a-zA-Z0-9_-]+=[^\s]+\s+)*(?:rm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b|rm\s+.*-(?:r|-recursive)\b.*-(?:f|-force)\b|rm\s+.*-(?:f|-force)\b.*-(?:r|-recursive)\b|rmdir\s+\/[sS]|rd\s+\/[sS]|del\s+\/[sS]|Remove-Item\b.*-(?:Recurse|r\b))/i.test(trimmed)) {
    return 'Destructive file deletion (e.g. rm -rf)';
  }

  // Git reset --hard, git clean -f, git checkout -f
  if (/(?:^|[;&|]\s*)(?:[a-zA-Z0-9_-]+=[^\s]+\s+)*git\s+(?:reset\s+--hard|clean\s+-(?:[a-zA-Z]*f[a-zA-Z]*|-force)|checkout\s+-(?:[a-zA-Z]*f[a-zA-Z]*|-force))\b/i.test(trimmed)) {
    return 'Discards uncommitted changes permanently (git reset --hard)';
  }

  // Git push
  if (/(?:^|[;&|]\s*)(?:[a-zA-Z0-9_-]+=[^\s]+\s+)*git\s+push\b/i.test(trimmed)) {
    return 'Pushes changes to remote repository (git push)';
  }

  return undefined;
}
