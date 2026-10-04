# fips-ui as a Nix package: the frontend built from web/package-lock.json (no hash to maintain: importNpmLock reads
# the lock file), and the server, which Node runs directly (TypeScript type stripping, no dependencies).
{
  lib,
  stdenv,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
  autoPatchelfHook,
  src,
  version,
}:

let
  nodejs = nodejs_24;

  web = buildNpmPackage {
    pname = "fips-ui-web";
    inherit version nodejs;
    src = lib.cleanSource (src + "/web");
    npmDeps = importNpmLock { npmRoot = src + "/web"; };
    npmConfigHook = importNpmLock.npmConfigHook;
    # The bundler's and Tailwind's native addons (rolldown, oxide, lightningcss) are prebuilt for ordinary glibc
    # distributions; point them at the Nix store's libraries before they are loaded.
    nativeBuildInputs = [ autoPatchelfHook ];
    buildInputs = [ stdenv.cc.cc.lib ];
    preBuild = "autoPatchelf node_modules";
    installPhase = ''
      runHook preInstall
      cp -r dist $out
      runHook postInstall
    '';
  };
in
stdenv.mkDerivation {
  pname = "fips-ui";
  inherit version;

  src = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (src + "/server")
      (src + "/scripts")
      (src + "/deploy")
      (src + "/package.json")
    ];
  };

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    share=$out/share/fips-ui
    mkdir -p $share/web $out/bin
    cp -r server scripts deploy package.json $share/
    cp -r ${web} $share/web/dist
    # The version the server reports (server/version.ts): there is no git checkout in the store.
    echo "version: ${version}" > $share/VERSION
    makeWrapper ${nodejs}/bin/node $out/bin/fips-ui \
      --add-flags $share/server/index.ts \
      --set-default NODE_ENV production
    runHook postInstall
  '';

  passthru = { inherit web nodejs; };

  meta = {
    description = "Web UI to manage and watch a FIPS mesh node";
    homepage = "https://github.com/fr34aky/fips-ui";
    license = lib.licenses.mit;
    mainProgram = "fips-ui";
    platforms = lib.platforms.linux;
  };
}
