{
  description = "fips-ui: web UI to manage and watch a FIPS mesh node";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Only for the NixOS VM test (checks.*.nixos): fips' own module and package.
    fips = {
      url = "github:jmcorgan/fips";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      fips,
    }:
    let
      lib = nixpkgs.lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAll = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      # Releases are git tags. A release fetched from GitHub (github:fr34aky/fips-ui/v0.8.0) has its tag in VERSION
      # (export-subst: "tag: v0.8.0"); anything else reports the last release, which package.json carries (the
      # release workflow updates it), plus the commit: 0.8.0+nix.1a2b3c4.
      tagged = builtins.match ".*tag: v([0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.]+)?)(,.*)?" (lib.strings.trim (builtins.readFile ./VERSION));
      version =
        if tagged != null then
          builtins.head tagged
        else
          "${(lib.importJSON ./package.json).version}+nix.${self.shortRev or self.dirtyShortRev or "unknown"}";
    in
    {
      packages = forAll (pkgs: rec {
        fips-ui = pkgs.callPackage ./nix/package.nix {
          inherit version;
          src = ./.;
        };
        default = fips-ui;
      });

      overlays.default = final: prev: { fips-ui = self.packages.${final.stdenv.hostPlatform.system}.default; };

      nixosModules.default =
        { pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          services.fips-ui.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };

      checks = forAll (pkgs: {
        fips-ui = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        nixos = pkgs.testers.runNixOSTest (import ./nix/test.nix { inherit self fips; });
      });

      formatter = forAll (pkgs: pkgs.nixfmt);
    };
}
