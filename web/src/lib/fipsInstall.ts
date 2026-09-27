// Fresh fips installs from the Upgrade page (server/upgrade.ts installDaemon, helper verb daemon-install).

/** A bootstrap peer as the helper takes it: npub1...@udp|tcp/host:port. */
export const PEER_SPEC_RE = /^npub1[02-9ac-hj-np-z]{58}@(udp|tcp)\/([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]|[0-9.]{7,15}):[0-9]{1,5}$/;

/** The public FIPS test node, as upstream's fips.yaml template lists it (also deploy/install-fips.sh). */
export const TEST_PEER = 'npub1qmc3cvfz0yu2hx96nq3gp55zdan2qclealn7xshgr448d3nh6lks7zel98@udp/test-us01.fips.network:2121';

/** The first helper version with daemon-install. */
export const DAEMON_INSTALL_HELPER = 9;
