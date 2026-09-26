import { KeyRound } from 'lucide-react';
import { Card, Copyable, Skeleton } from './ui';
import type { HelperInfo } from '../lib/admin';

export function HelperGate({ helper, children }: { helper: HelperInfo | null | undefined; children: React.ReactNode }) {
  if (!helper) return <Skeleton className="h-24 w-full" />;
  if (helper.managementCapable) return <>{children}</>;
  return (
    <Card>
      <div className="flex items-start gap-3 text-sm">
        <KeyRound size={18} className="text-warn mt-0.5 shrink-0" />
        <div className="grid gap-2">
          <div className="font-medium">Node management needs the privileged helper, version 3 or newer</div>
          <div className="text-ink-2">{helper.error ?? 'The helper is not available.'} Changing fips.yaml, the firewall and the fips services needs root, and the only root path this UI has is the helper, installed from a shell:</div>
          <Copyable text="sudo ./deploy/setup-local.sh" className="rounded-lg bg-surface-2 px-3 py-2 text-xs w-fit" />
        </div>
      </div>
    </Card>
  );
}
