import { KeyRound } from 'lucide-react';
import { Card, Copyable, Skeleton } from './ui';
import type { HelperInfo } from '../lib/admin';

/**
 * Shows its children only when the helper can do what the page needs: the configuration editor ("config", the
 * default) or the firewall ("firewall"). Otherwise it says what is missing and how to install the helper.
 */
export function HelperGate({ helper, need = 'config', children }: { helper: HelperInfo | null | undefined; need?: 'config' | 'firewall'; children: React.ReactNode }) {
  if (!helper) return <Skeleton className="h-24 w-full" />;
  const firewallOk = helper.features ? helper.features.firewall !== 'none' : helper.managementCapable;
  if (helper.managementCapable && (need === 'config' || firewallOk)) return <>{children}</>;
  // The helper works, but this system has no firewall backend it drives.
  if (helper.managementCapable && need === 'firewall') {
    return <Card><div className="text-sm text-ink-2">Managing the fips firewall is not supported on this system ({helper.serviceManager ?? 'unknown service manager'}): the helper drives nftables on Linux and pf on FreeBSD and macOS.</div></Card>;
  }
  const systemd = !helper.serviceManager || helper.serviceManager === 'systemd';
  return (
    <Card>
      <div className="flex items-start gap-3 text-sm">
        <KeyRound size={18} className="text-warn mt-0.5 shrink-0" />
        <div className="grid gap-2">
          <div className="font-medium">Node management needs the privileged helper{systemd ? ', version 4 or newer' : ', version 8 or newer'}</div>
          <div className="text-ink-2">{helper.error ?? 'The helper is not available.'} Changing fips.yaml, the firewall and the fips services needs root, and the only root path this UI has is the helper, installed from a shell in the fips-ui directory:</div>
          <Copyable text={systemd ? 'sudo ./deploy/setup-local.sh' : 'sudo ./deploy/install-upgrade-helper.sh'} className="rounded-lg bg-surface-2 px-3 py-2 text-xs w-fit" />
        </div>
      </div>
    </Card>
  );
}
