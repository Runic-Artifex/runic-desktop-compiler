{
  description = "Runic Desktop Compiler: JavaScript framework applications to native Rust + Blitz";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    runtime = with pkgs; [ wayland libxkbcommon libx11 libxcursor libxi libxrandr libxcb ];
    # Browser reference runs: full Chromium (new headless mode) at the revision
    # pinned by playwright-driver. The npm `playwright-core` must match its version.
    playwrightBrowsers = pkgs.playwright-driver.browsers.override {
      withFirefox = false;
      withWebkit = false;
      withFfmpeg = false;
      withChromiumHeadlessShell = false; # rounds glyph advances; see conformance/harness
    };
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [ nodejs_24 cargo rustc rustfmt clippy pkg-config python3 clang lld git patchelf xdotool imagemagick prettier ] ++ runtime;
      LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtime;
      RUST_BACKTRACE = "1";
      CARGO_BUILD_JOBS = "2";
      PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      RUNIC_PLAYWRIGHT_VERSION = pkgs.playwright-driver.version;
    };
  };
}
