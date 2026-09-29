{ inputs, ... }:
{
  imports = [ inputs.treefmt-nix.flakeModule ];

  perSystem =
    { config, ... }:
    {
      treefmt = {
        inherit (config.flake-root) projectRootFile;
        programs.nixfmt.enable = true;
        programs.clang-format.enable = true;
        programs.shfmt = {
          enable = true;
          indent_size = 2;
        };
      };
    };
}
