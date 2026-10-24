# Pingvin Share

Enzimo's security maintenance fork of [stonith404/Pingvin Share](https://github.com/stonith404/pingvin-share).
The original project's BSD-2-Clause license and contributor history are preserved.

Use `ghcr.io/enzimo/pingvin-share:v1.16.0` for this fork. Read
[the release notes](RELEASE_NOTES.md) before upgrading from the original image,
especially the proxy, OAuth, and anonymous upload changes.

```sh
docker compose pull
docker compose up -d
```

The supplied compose file keeps the original data mounts and port 3000.
See [SECURITY.md](SECURITY.md) for supported versions and reporting.

Pingvin Share is a self-hosted file sharing platform and an alternative for WeTransfer.

## ✨ Features

- Share files using a link
- Administrators can add files to existing shares
- Unlimited file size (restricted only by disk space)
- Set an expiration date for shares
- Secure shares with visitor limits and passwords
- Email recipients
- Reverse shares
- OIDC and LDAP authentication
- Integration with ClamAV for security scans
- Different file providers: local storage and S3

### Add files to a share

In **Administration → Share management**, click **Add files** beside a share,
select the files, then click **Add files** in the dialog. Administrators can
add to another user's share or an anonymous share. The share must be completed,
active, and within its size limit. Existing filenames cannot be overwritten.

The share link, expiry, password, and visitor limits stay in place. Completed
files become available individually, and the ZIP is rebuilt. Additions do not
resend completion emails or consume reverse-share uses. Local and S3 shares use
their original storage provider.

## 🐧 Get to know Pingvin Share

- [Demo](https://pingvin-share.dev.eliasschneider.com)
- [Review by DB Tech](https://www.youtube.com/watch?v=rWwNeZCOPJA)

<img src="https://user-images.githubusercontent.com/58886915/225038319-b2ef742c-3a74-4eb6-9689-4207a36842a4.png" width="700"/>

## ⌨️ Setup

### Installation with Docker (recommended)

1. Download the `docker-compose.yml` file
2. Run `docker compose up -d`

The website is now listening on `http://localhost:3000`, have fun with Pingvin Share 🐧!

> [!TIP]
> Checkout [Pocket ID](https://github.com/stonith404/pocket-id), a user-friendly OIDC provider that lets you easily log in to services like Pingvin Share using Passkeys.

## 📚 Documentation

For more installation options and advanced configurations, please refer to the [documentation](https://stonith404.github.io/pingvin-share).

## 🖤 Contribute

We would love it if you want to help make Pingvin Share better! You can either [help to translate](https://stonith404.github.io/pingvin-share/help-out/translate) Pingvin Share or [contribute to the codebase](https://stonith404.github.io/pingvin-share/help-out/contribute).
