// Shapes returned by the FIPS control socket (see upstream docs/reference/control-socket.md).
export interface LinkStats { bytes_recv: number; bytes_sent: number; packets_recv: number; packets_sent: number; last_recv_ms?: number }

export interface Mmp {
  delivery_ratio_forward: number; delivery_ratio_reverse: number; etx: number; goodput_bps: number; loss_rate: number;
  lqi: number; mode: string; smoothed_etx: number; smoothed_loss: number; srtt_ms: number;
  goodput_trend?: string; jitter_trend?: string; loss_trend?: string; rtt_trend?: string; ecn_ce_count?: number; spin_bit_role?: string;
}

export interface Peer {
  node_addr: string; npub: string; display_name?: string | null; ipv6_addr: string; connectivity: string; link_id: number | null;
  direction: string; transport_addr: string; transport_type: string; is_parent: boolean; is_child: boolean; tree_depth: number | null;
  effective_depth: number | null; stats: LinkStats; noise?: { highest_recv_counter: number; send_counter: number }; current_k_bit?: boolean;
  mmp?: Mmp | null; nostr_traversal?: { consecutive_failures: number; cooldown_until_ms: number | null; in_cooldown: boolean; last_observed_skew_ms: number | null };
  rekey_in_progress?: boolean; rekey_draining?: boolean; has_bloom_filter?: boolean; has_tree_position?: boolean; authenticated_at_ms?: number; last_seen_ms?: number;
  filter_sequence?: number; consecutive_decrypt_failures?: number; replay_suppressed?: number; our_session_index?: string;
}

export interface Link { link_id: number; transport_id: number; remote_addr: string; direction: string; state: string; created_at_ms: number; stats: LinkStats }

export interface TransportInterface { name: string; presence: string; carrier: boolean; policy: string; since_secs: number; binds: number; failed_attempts: number }
export interface Transport {
  transport_id: number; type: string; state: string; mtu: number; name?: string; local_addr?: string; tor_mode?: string; onion_address?: string;
  tor_monitoring?: unknown; interface?: TransportInterface; stats: Record<string, number>;
}

export interface TreePeer { coords: string[]; depth: number; display_name?: string | null; distance_to_us: number; node_addr: string; root: string }
export interface Tree {
  declaration_sequence: number; declaration_signed: boolean; depth: number; is_root: boolean; my_coords: string[]; my_node_addr: string;
  parent: string | null; parent_display_name?: string | null; peer_tree_count: number; peers: TreePeer[]; root: string; root_npub?: string; stats?: Record<string, number>;
}

export interface Session {
  remote_addr: string; npub?: string; display_name?: string | null; state: string; is_initiator: boolean; last_activity_ms: number;
  stats?: Record<string, number>; mmp?: Mmp | null; current_k_bit?: boolean; is_draining?: boolean;
}

export interface PendingConnection { link_id: number; direction: string; handshake_state: string; started_at_ms: number; idle_ms: number; resend_count: number; expected_peer?: string }

export interface ListeningSocket { proto: string; local_addr: string; port: number; pid: number | null; process: string | null; wildcard_bind: boolean; filter: string }
export interface Listening { fips0_addr: string; firewall_active: boolean; sockets: ListeningSocket[] }

export interface Status {
  version: string; npub: string; node_addr: string; ipv6_addr: string; state: string; is_leaf_only: boolean; is_root: boolean; root: string;
  persistent: boolean; peer_count: number; session_count: number; link_count: number; transport_count: number; connection_count: number;
  transport_peer_counts: Record<string, number>; tun_state: string; tun_name: string; effective_ipv6_mtu: number; control_socket: string;
  pid: number; exe_path: string; uptime_secs: number; estimated_mesh_size: number; forwarding: Record<string, number>;
  sparklines: Record<string, number[]>;
}

export interface UnitState { unit: string; id: 'fips' | 'fips-dns' | 'fips-firewall' | 'fips-gateway'; loaded: boolean; active: string; sub: string; description: string; since?: number; mainPid?: number; memoryBytes?: number; cpuUsageNs?: number; restarts?: number; unitFileState?: string }

export interface Gateway {
  pool_total: number; pool_allocated: number; pool_active: number; pool_draining: number; pool_free: number; nat_mappings: number; dns_listen: string;
  uptime_secs: number; pool_cidr: string; lan_interface: string; dns_upstream: string; dns_ttl: number; pool_grace_period: number;
  mappings?: { virtual_ip: string; mesh_addr: string; node_addr: string; dns_name: string; state: string; sessions: number; age_secs: number; last_ref_secs: number }[];
}

export interface Snapshot {
  ts: number; status?: Status; peers?: { peers: Peer[] }; links?: { links: Link[] }; transports?: { transports: Transport[] }; tree?: Tree;
  sessions?: { sessions: Session[] }; connections?: { connections: PendingConnection[] }; listening?: Listening; units?: UnitState[]; gateway?: Gateway | null;
  errors: Record<string, string>;
}

export interface LogLine { ts: number; level: 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown'; target?: string; message: string; raw: string; cursor?: string }

export type Principal = { kind: 'local'; role: 'admin' } | { kind: 'mesh'; role: 'viewer' | 'admin'; npub: string; label?: string; address: string };
export interface Health { ok: boolean; auth: 'token' | 'none' | 'npub'; principal?: Principal; readOnly: boolean; serviceControl: boolean; nodeManagement?: boolean; socket: string; gatewaySocket: string | null; pollMs: number; uiVersion?: string; uiUptimeSecs: number; error?: string; version?: string; pubdom?: PubdomState }

// Public domain names over fips (fr34aky/fips-pub-domains): what the node runs, and what the two
// control sockets answer (that repository's docs/webui.md).
export interface PubdomUnit { loaded: boolean; active: string; sub: string; enabled: string }
export interface PubdomSide { socket: string; running: boolean; installed: boolean; /** the binary's version (fullState) */ version?: string | null; /** the systemd unit's state, null elsewhere */ unit?: PubdomUnit | null }
export interface PubdomState { resolver: PubdomSide; server: PubdomSide; /** the helper can install here (systemd) */ canInstall?: boolean }
export interface PubdomRelease { tag: string; version: string; url: string; publishedAt: string }
export interface PubdomReleases { repo: string; latest: PubdomRelease | null; error?: string; checkedAt: number }
export interface PubdomAttestation { witness: string; servers: string[]; names_this_server: boolean; method: string; verified_at: number; created_at: number }
export interface PubdomCheckDns { domain: string; verdict: string; detail: string | null; ttl: number | null; upstreams: string[]; txt_record: string }
/** A file the editors show: its text and the hash the helper checks before replacing it ('none' when it does not exist). */
export interface PubdomFileText { path: string; text: string; base: string }
export interface PubdomRelay { url: string; accepted_at: number | null; last_error: string | null }
export interface PubdomServerStatus { version: string; npub: string; address: string; bind: string; port: number; zones_dir: string | null; publishing: boolean; relays: PubdomRelay[] }
export interface PubdomName { label: string; target: string }
export interface PubdomZone { domain: string; file: string; port: number; names: PubdomName[]; txt_record: string; claim_published_at: number | null; zone_published_at: number | null; dnssec_proof_until: number | null; next_publish_at: number | null; last_error: string | null }
export interface PubdomZones { zones: PubdomZone[]; skipped: { file: string }[] }
export interface PubdomResolverStatus { version: string; online: boolean; upstreams: string[]; listen: string[]; upstreams_from: string | null; backend: string | null; pins: string; dnssec: boolean; plain_probe: boolean; witnesses: string[]; attestation_threshold: number; mesh_relays: string[]; public_relays: string[] }
export interface PubdomPin { domain: string; npub: string; port: number; method: string; verified_at: number }

export interface MetricDef { name: string; scope: 'node' | 'peer'; unit: string }
export interface Series { metric: string; unit: string; granularity_seconds: number; values: (number | null)[] }
export interface StatsPeer { npub: string; node_addr: string; display_name?: string | null; is_active: boolean; first_seen_secs_ago: number; last_contact_secs_ago: number }
export interface HostEntry { hostname: string; npub: string; comment?: string }

export interface ProbeStage { verdict: string; reason?: string | null; detail?: string | null; elapsed_ms: number; [k: string]: unknown }
export interface ProbeReport {
  probe_id: number; overall: string; elapsed_ms: number; tick_ms: number;
  target: { display_name?: string | null; ipv6_addr: string; node_addr: string; npub: string };
  bloom: ProbeStage; discovery: ProbeStage; path: ProbeStage; session: ProbeStage; rtt: ProbeStage; cleanup: Record<string, unknown>;
}
