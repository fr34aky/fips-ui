# NixOS VM test: upstream's fips module and fips-ui's module together, then fips-ui's smoke test against them.
# Run with: nix build .#checks.x86_64-linux.nixos
{ self, fips }:
{
  name = "fips-ui";

  nodes.machine =
    { pkgs, ... }:
    {
      imports = [
        fips.nixosModules.default
        self.nixosModules.default
      ];
      nixpkgs.overlays = [ fips.overlays.default ];
      services.fips.enable = true;
      services.fips.dns.enable = false;
      services.fips-ui.enable = true;
      environment.systemPackages = [ pkgs.nodejs_24 pkgs.curl ];
      virtualisation.memorySize = 2048;
    };

  testScript =
    { nodes, ... }:
    let
      share = "${nodes.machine.services.fips-ui.package}/share/fips-ui";
    in
    ''
      machine.wait_for_unit("fips.service")
      machine.wait_for_unit("fips-ui.service")
      machine.wait_for_open_port(8321)

      # The whole dashboard against the real daemon, with the helper through its sudo rule.
      machine.succeed("node ${share}/scripts/smoke-test.mjs --os linux --daemon --helper --supervised >&2")

      # The configuration editor reads upstream's config, through the helper.
      machine.succeed("curl -sf http://127.0.0.1:8321/api/admin/config | grep -q '/var/lib/fips/fips.yaml'")
      # The helper knows NixOS: no firewall unit to manage, fips binaries are not installed from the UI.
      machine.succeed("curl -sf http://127.0.0.1:8321/api/admin/status | grep -q '\"firewall\":\"none\"'")
      out = machine.fail("curl -sf -X POST -H 'content-type: application/json' -d '{\"source\":\"release\"}' http://127.0.0.1:8321/api/upgrade/jobs")
      machine.succeed("curl -s -X POST -H 'content-type: application/json' -d '{\"source\":\"release\"}' http://127.0.0.1:8321/api/upgrade/jobs | grep -q 'managed by Nix'")
      # fips-ui's self-update points to the flake.
      machine.succeed("curl -sf http://127.0.0.1:8321/api/ui-update | grep -q 'installed with Nix'")
    '';
}
