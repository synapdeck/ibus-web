# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-2.0-or-later
{
  perSystem =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      hangul = pkgs.ibus-engines.hangul;
      native = config.packages.ibus-test-native;
      busConfig = pkgs.writeText "ibus-test-session-bus.conf" ''
        <busconfig>
          <type>session</type>
          <listen>unix:tmpdir=/tmp</listen>
          <auth>EXTERNAL</auth>
          <policy context="default">
            <allow own="*"/>
            <allow send_destination="*"/>
            <allow receive_sender="*"/>
          </policy>
        </busconfig>
      '';
      nativeConfig = pkgs.writeText "hangul-native-session.json" (
        builtins.toJSON {
          sessionBus = [
            "${pkgs.dbus}/bin/dbus-daemon"
            "--config-file=${busConfig}"
          ];
          daemon = [
            "${pkgs.ibus}/bin/ibus-daemon"
            "--single"
            "--emoji-extension=disable"
          ];
          daemonDestination = "org.freedesktop.IBus";
          configService = {
            command = [ "${pkgs.ibus}/libexec/ibus-dconf" ];
            destination = "org.freedesktop.IBus.Config";
          };
          engine = [
            "${hangul}/libexec/ibus-engine-hangul"
            "--ibus"
          ];
          adapter = [ "${native}/bin/ibus-test-native" ];
          gdbus = [ "${pkgs.glib.bin}/bin/gdbus" ];
          gsettings = [ "${pkgs.glib.bin}/bin/gsettings" ];
          destination = "org.freedesktop.IBus.Hangul";
          factory = "/org/freedesktop/IBus/Factory";
          env = {
            GSETTINGS_SCHEMA_DIR = "${hangul}/share/gsettings-schemas/${hangul.name}/glib-2.0/schemas";
            XDG_DATA_DIRS = "${hangul}/share:${pkgs.ibus}/share";
          };
          timeoutMs = 5000;
        }
      );
    in
    {
      packages = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        ibus-test-hangul-config = nativeConfig;
      };
      checks = lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        hangul-native-session = config.ibusWeb.testing.vitestCheck {
          name = "hangul-native-session";
          packageDir = "${config.packages.ibus-test-tools}/tools";
          env = {
            IBUS_TEST_NATIVE_CONFIG = nativeConfig;
            IBUS_TEST_FIXTURE_COMMAND = builtins.toJSON [ "${native}/libexec/test-engine" ];
          };
          inBrowsers = false;
          limit = 60;
          vitestArgs = [ "ibus-test/session.test.ts" ];
        };
      };
    };
}
