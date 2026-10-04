# NixOS module for fips-ui, next to upstream fips' own module:
#
#   imports = [ fips.nixosModules.default fips-ui.nixosModules.default ];
#   services.fips.enable = true;
#   services.fips-ui.enable = true;
#
# fips-ui runs as a systemd service in the fips group (the daemon's control socket, /etc/fips/hosts and
# /var/lib/fips/fips.yaml are the group's). Its privileged helper is installed from the package with its tools on
# PATH and one sudo rule for the UI user; the helper knows NixOS (fips.yaml in /var/lib/fips, no binary installs,
# units declared here). fips and fips-ui themselves are updated through the flake inputs, not from the UI.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.fips-ui;
  stateDir = "/var/lib/fips-ui";
  defaultUser = cfg.user == "fips-ui";
  # Upstream's module runs fips from the store without putting it on PATH: tell the helper (fipsctl, version) and the
  # Upgrade page where the binaries are.
  fipsBin = lib.optionalString (config.services ? fips && config.services.fips.enable) "${config.services.fips.package}/bin";

  helperDeps = with pkgs; [
    bash
    coreutils
    util-linux
    gnused
    gawk
    gnugrep
    findutils
    diffutils
    procps
    nftables
    iproute2
    systemd
    shadow
    (python3.withPackages (p: [ p.pyyaml ]))
  ];

  # sudo resets the environment; the wrapper sets PATH and the NixOS mode inside the rule's command.
  helper = pkgs.runCommand "fips-ui-helper" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    makeWrapper ${cfg.package}/share/fips-ui/scripts/fips-ui-helper $out/bin/fips-ui-helper \
      --set FIPS_UI_NIXOS 1 \
      ${lib.optionalString (fipsBin != "") "--set FIPS_BIN_DIR ${fipsBin}"} \
      --set PATH ${lib.makeBinPath helperDeps}:/run/current-system/sw/bin
  '';
in
{
  options.services.fips-ui = {
    enable = lib.mkEnableOption "fips-ui, the web UI for a FIPS mesh node";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The fips-ui package (the flake's packages.default).";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "fips-ui";
      description = ''
        User fips-ui runs as. The default is a system user created by this module. Any user is added to the
        fips group (control socket, hosts file, fips.yaml) and systemd-journal (the Logs page).
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address the dashboard listens on. Bind to a non-loopback address only with FIPS_UI_TOKEN set.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8321;
      description = "Port of the dashboard (and of Web UI over the mesh).";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        FIPS_UI_ALLOWED_HOSTS = "mynode.lan,mynode.fips";
      };
      description = "Further FIPS_UI_* settings (see the README); secrets belong in environmentFile.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/fips-ui.env";
      description = "File with KEY=value settings read by systemd, for secrets such as FIPS_UI_TOKEN or FIPS_UI_GITHUB_TOKEN.";
    };

    helper.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Install the privileged helper and one NOPASSWD sudo rule that lets the UI user run it (and nothing
        else): the configuration editor, service buttons, hosts file and the guard of Web UI over the mesh need it.
      '';
    };

    meshAccess.openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Open the dashboard's port on the FIPS interface (fips0) in the NixOS firewall, for Web UI over the mesh.
        fips-ui still admits only the npubs allowed on its Access page, behind its own guard.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    warnings = lib.optional (
      !(config.services ? fips && config.services.fips.enable)
    ) "services.fips-ui is enabled without services.fips (import fips.nixosModules.default and enable it): fips-ui needs the daemon on this machine.";

    users.users.${cfg.user} =
      if defaultUser then
        {
          isSystemUser = true;
          group = "fips-ui";
          home = stateDir;
          extraGroups = [
            "fips"
            "systemd-journal"
          ];
        }
      else
        {
          extraGroups = [
            "fips"
            "systemd-journal"
          ];
        };
    users.groups = lib.mkIf defaultUser { fips-ui = { }; };

    systemd.services.fips-ui = {
      description = "fips-ui, web UI for the FIPS mesh node";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "fips.service"
      ];
      wants = [ "network-online.target" ];
      # sudo (for the helper) is a NixOS wrapper.
      path = [ "/run/wrappers" ];
      environment = {
        FIPS_UI_HOST = cfg.host;
        FIPS_UI_PORT = toString cfg.port;
        # Installed with Nix: the Upgrade page and the self-update point to the flake instead.
        FIPS_UI_NIX = "1";
        FIPS_UI_SUPERVISED = "1";
        NODE_ENV = "production";
        XDG_CONFIG_HOME = "${stateDir}/config";
        XDG_DATA_HOME = "${stateDir}/data";
      }
      // lib.optionalAttrs cfg.helper.enable { FIPS_UI_HELPER = "${helper}/bin/fips-ui-helper"; }
      // lib.optionalAttrs (fipsBin != "") { FIPS_BIN_DIR = fipsBin; }
      // cfg.environment;
      serviceConfig = {
        User = cfg.user;
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 3;
        StateDirectory = "fips-ui";
        StateDirectoryMode = "0700";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
      };
    };

    security.sudo.extraRules = lib.mkIf cfg.helper.enable [
      {
        users = [ cfg.user ];
        commands = [
          {
            command = "${helper}/bin/fips-ui-helper";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];

    networking.firewall.interfaces.fips0.allowedTCPPorts = lib.mkIf cfg.meshAccess.openFirewall [ cfg.port ];
  };
}
