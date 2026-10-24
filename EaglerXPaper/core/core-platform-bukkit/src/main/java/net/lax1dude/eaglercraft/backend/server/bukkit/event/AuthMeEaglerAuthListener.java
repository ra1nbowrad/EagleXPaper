/*
 * Copyright (c) 2026 ra1nbowrad. All Rights Reserved.
 * Licensed under the BSD 2-Clause License, consistent with EaglerXPaper.
 */
package net.lax1dude.eaglercraft.backend.server.bukkit.event;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.entity.Player;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.Plugin;

import net.lax1dude.eaglercraft.backend.server.api.bukkit.event.EaglercraftAuthCheckRequiredEvent;
import net.lax1dude.eaglercraft.backend.server.api.bukkit.event.EaglercraftAuthPasswordEvent;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthCheckRequiredEvent;
import net.lax1dude.eaglercraft.backend.server.api.event.IEaglercraftAuthPasswordEvent;
import net.lax1dude.eaglercraft.backend.server.bukkit.PlatformPluginBukkit;
import net.lax1dude.eaglercraft.backend.server.bukkit.BukkitUnsafe;
import net.lax1dude.eaglercraft.backend.server.adapter.PipelineAttributes;
import net.lax1dude.eaglercraft.backend.server.base.NettyPipelineData;

/**
 * Optional AuthMe bridge for EaglerXPaper's authentication events.
 *
 * Plaintext password responses are only accepted over WSS. The AuthMe API is
 * accessed reflectively so AuthMe remains an optional runtime dependency.
 */
public final class AuthMeEaglerAuthListener implements Listener {

    private static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9_]{3,16}$");
    private static final Pattern UUID_PATTERN = Pattern.compile("\"id\"\\s*:\\s*\"([0-9a-fA-F]{32})\"");
    private static final Pattern NAME_PATTERN = Pattern.compile("\"name\"\\s*:\\s*\"([A-Za-z0-9_]{3,16})\"");

    private final PlatformPluginBukkit plugin;
    private final ConcurrentMap<String, Long> authenticatedNames = new ConcurrentHashMap<>();

    public AuthMeEaglerAuthListener(PlatformPluginBukkit plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onAuthCheckRequired(EaglercraftAuthCheckRequiredEvent event) {
        if (!event.getPendingConnection().isWebSocketSecure()) {
            event.setAuthRequired(IEaglercraftAuthCheckRequiredEvent.EnumAuthResponse.DENY);
            event.setKickMessage("AuthMe login requires a secure WSS connection.");
            return;
        }

        String username = decodeUsername(event.getAuthUsername());
        if (!isValidUsername(username) || !isAuthMeAvailable()) {
            event.setAuthRequired(IEaglercraftAuthCheckRequiredEvent.EnumAuthResponse.DENY);
            event.setKickMessage("AuthMe is unavailable or this account cannot be authenticated.");
            return;
        }

        event.setNicknameSelectionEnabled(false);
        event.setEnableCookieAuth(false);
        event.setUseAuthType(IEaglercraftAuthCheckRequiredEvent.EnumAuthType.PLAINTEXT);
        event.setAuthMessage("Enter your AuthMe password");
        event.setAuthRequired(IEaglercraftAuthCheckRequiredEvent.EnumAuthResponse.REQUIRE);
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onAuthPassword(EaglercraftAuthPasswordEvent event) {
        String username = event.getProfileUsername();
        if (!event.getLoginConnection().isWebSocketSecure()) {
            event.setLoginDenied("AuthMe password authentication requires WSS.");
            return;
        }
        if (!isValidUsername(username) || !isAuthMeAvailable()
                || event.getAuthType() != IEaglercraftAuthCheckRequiredEvent.EnumAuthType.PLAINTEXT) {
            event.setLoginDenied("AuthMe authentication is not configured for this connection.");
            return;
        }

        byte[] passwordBytes = event.getAuthPasswordDataResponse();
        if (passwordBytes == null || passwordBytes.length == 0 || passwordBytes.length > 1024) {
            event.setLoginDenied("Invalid password response.");
            return;
        }

        // This event is dispatched asynchronously by EaglerXPaper. Never log
        // or otherwise expose the supplied password.
        String password = new String(passwordBytes, StandardCharsets.UTF_8);
        try {
            Object api = getAuthMeApi();
            if (api == null || !isRegistered(api, username) || !checkPassword(api, username, password)) {
                event.setLoginDenied("Incorrect AuthMe username or password.");
                return;
            }

            PremiumProfile premiumProfile = resolvePremiumProfile(username);
            if (premiumProfile == null || !username.equalsIgnoreCase(premiumProfile.name)) {
                event.setLoginDenied("This username does not resolve to a premium Minecraft profile.");
                return;
            }

            event.setProfileUsername(premiumProfile.name);
            event.setProfileUUID(premiumProfile.uuid);
            String authenticatedKey = premiumProfile.name.toLowerCase(Locale.ROOT);
            long authenticatedAt = System.currentTimeMillis();
            authenticatedNames.put(authenticatedKey, authenticatedAt);
            plugin.getServer().getScheduler().runTaskLater(plugin,
                    () -> authenticatedNames.remove(authenticatedKey, authenticatedAt), 20L * 30L);
            event.setLoginAllowed();
        } catch (Exception ex) {
            Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
            plugin.getLogger().warning("AuthMe Eagler authentication failed for " + username
                    + " (" + cause.getClass().getSimpleName() + ").");
            event.setLoginDenied("Authentication service unavailable. Please try again.");
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!isEaglerPlayer(player)) {
            return;
        }
        String key = player.getName().toLowerCase(Locale.ROOT);
        Long authenticatedAt = authenticatedNames.remove(key);
        if (authenticatedAt == null || System.currentTimeMillis() - authenticatedAt > 30000L) {
            return;
        }

        // Let AuthMe's normal join handler initialize its login state first,
        // then tell AuthMe this player already passed its password API check.
        plugin.getServer().getScheduler().runTask(plugin, () -> {
            if (!player.isOnline() || !isEaglerPlayer(player) || !isAuthMeAvailable()) {
                return;
            }
            try {
                Object api = getAuthMeApi();
                if (api == null) {
                    return;
                }
                api.getClass().getMethod("forceLogin", Player.class).invoke(api, player);
            } catch (Exception ex) {
                Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
                plugin.getLogger().warning("Could not complete AuthMe login for Eagler player "
                        + player.getName() + " (" + cause.getClass().getSimpleName() + ").");
            }
        });
    }

    private boolean isEaglerPlayer(Player player) {
        try {
            NettyPipelineData data = BukkitUnsafe.getPlayerChannel(player)
                    .attr(PipelineAttributes.<NettyPipelineData>pipelineData()).get();
            return data != null && data.isEaglerPlayer();
        } catch (Throwable ignored) {
            return false;
        }
    }

    private boolean isAuthMeAvailable() {
        Plugin authMe = plugin.getServer().getPluginManager().getPlugin("AuthMe");
        return authMe != null && authMe.isEnabled();
    }

    private Object getAuthMeApi() throws Exception {
        Class<?> apiClass = Class.forName("fr.xephi.authme.api.v3.AuthMeApi");
        return apiClass.getMethod("getInstance").invoke(null);
    }

    private boolean isRegistered(Object api, String username) throws Exception {
        Object result = api.getClass().getMethod("isRegistered", String.class).invoke(api, username);
        return Boolean.TRUE.equals(result);
    }

    private boolean checkPassword(Object api, String username, String password) throws Exception {
        Object result = api.getClass().getMethod("checkPassword", String.class, String.class)
                .invoke(api, username, password);
        return Boolean.TRUE.equals(result);
    }

    private static String decodeUsername(byte[] username) {
        return username == null ? "" : new String(username, StandardCharsets.US_ASCII);
    }

    private static boolean isValidUsername(String username) {
        return username != null && USERNAME.matcher(username).matches();
    }

    private static PremiumProfile resolvePremiumProfile(String username) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL(
                "https://api.mojang.com/users/profiles/minecraft/" + username).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(2500);
        connection.setReadTimeout(2500);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "EaglerXPaper-AuthMe-Bridge");
        try {
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                return null;
            }
            String body;
            try (InputStream input = connection.getInputStream();
                    ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    if (output.size() > 16384) {
                        return null;
                    }
                }
                body = output.toString(StandardCharsets.UTF_8.name());
            }

            Matcher idMatcher = UUID_PATTERN.matcher(body);
            Matcher nameMatcher = NAME_PATTERN.matcher(body);
            if (!idMatcher.find() || !nameMatcher.find()) {
                return null;
            }
            String id = idMatcher.group(1);
            UUID uuid = UUID.fromString(id.substring(0, 8) + "-" + id.substring(8, 12) + "-"
                    + id.substring(12, 16) + "-" + id.substring(16, 20) + "-" + id.substring(20));
            return new PremiumProfile(uuid, nameMatcher.group(1));
        } finally {
            connection.disconnect();
        }
    }

    private static final class PremiumProfile {
        private final UUID uuid;
        private final String name;

        private PremiumProfile(UUID uuid, String name) {
            this.uuid = uuid;
            this.name = name;
        }
    }
}
