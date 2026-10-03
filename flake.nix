{
  description = "React subset to native Blitz compiler research prototype";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    runtime = with pkgs; [ wayland libxkbcommon libx11 libxcursor libxi libxrandr libxcb ];
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [ nodejs_24 cargo rustc rustfmt clippy pkg-config python3 clang lld git patchelf xdotool imagemagick ] ++ runtime;
      LIBCLANG_PATH = "${pkgs.libclang.lib}/lib";
      LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath runtime;
      RUST_BACKTRACE = "1";
      CARGO_BUILD_JOBS = "2";
    };
  };
}
