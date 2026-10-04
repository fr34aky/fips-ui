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
      # Releases are git tags; package.json carries the last release (the release workflow updates it), so a build
      # reports e.g. 0.8.0+nix.1a2b3c4.
      version = "${(lib.importJSON ./package.json).version}+nix.${self.shortRev or self.dirtyShortRev or "unknown"}";
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
