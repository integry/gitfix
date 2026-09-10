import type { DesktopGitHubAccount } from '../../../apps/desktop/src/shared/github-account';

/** Shared display only; selecting this component never changes authorization. */
export const GitHubAccountIdentity = ({ account }: { account: DesktopGitHubAccount }) => (
  <span className="inline-flex items-center gap-2">
    {account.avatarUrl && <img src={account.avatarUrl} alt="" width={24} height={24} className="rounded-full" referrerPolicy="no-referrer" />}
    <span>@{account.username}</span>
  </span>
);
