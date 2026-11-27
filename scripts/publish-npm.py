#!/usr/bin/env python3
"""Publish the bundle to npm without the npm CLI.

There is no npm and no node on PATH here, and the registry is one HTTP PUT away,
so this script assembles the publish document itself: the tarball already has the
`package/` layout npm expects, so we only need the manifest, the dist block and
the base64 attachment.

The token is read from NPM_TOKEN, or from the `_authToken` line of ~/.npmrc, so
it never has to travel through a command line.

    python scripts/publish-npm.py --dry-run     # build the document, touch nothing
    python scripts/publish-npm.py               # publish and print the registry reply
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = "https://registry.npmjs.org"


def manifest_from_tarball(path: str) -> dict:
    with tarfile.open(path, "r:gz") as tar:
        member = next((m for m in tar.getmembers() if m.name == "package/package.json"), None)
        if member is None:
            raise SystemExit(f"{path} has no package/package.json — is it an npm pack layout?")
        handle = tar.extractfile(member)
        return json.loads(handle.read().decode("utf-8"))


def token() -> str:
    env = os.environ.get("NPM_TOKEN") or os.environ.get("NODE_AUTH_TOKEN")
    if env:
        return env.strip()
    npmrc = os.path.join(os.path.expanduser("~"), ".npmrc")
    if os.path.exists(npmrc):
        text = io.open(npmrc, encoding="utf-8", errors="replace").read()
        match = re.search(r"_authToken\s*=\s*(\S+)", text)
        if match:
            return match.group(1).strip()
    raise SystemExit(
        "no npm token: set NPM_TOKEN, or put\n"
        "  //registry.npmjs.org/:_authToken=<token>\n"
        "into ~/.npmrc (an automation or granular token with publish rights)."
    )


def build(tarball: str, tags: list[str]) -> tuple[dict, bytes]:
    data = io.open(tarball, "rb").read()
    manifest = manifest_from_tarball(tarball)
    name, version = manifest["name"], manifest["version"]
    filename = f"{name}-{version}.tgz"
    shasum = hashlib.sha1(data).hexdigest()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")

    published = dict(manifest)
    published["dist"] = {
        "shasum": shasum,
        "integrity": integrity,
        "tarball": f"{REGISTRY}/{name}/-/{filename}",
    }
    document = {
        "_id": name,
        "name": name,
        "description": manifest.get("description", ""),
        "dist-tags": {tag: version for tag in tags},
        "versions": {version: published},
        "readme": "Drive a running QGIS 4 from DeepSeek Harness through ten qgis_* tools.",
        "_attachments": {
            filename: {
                "content_type": "application/octet-stream",
                "data": base64.b64encode(data).decode("ascii"),
                "length": len(data),
            }
        },
    }
    return document, data


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tarball")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--tag", action="append", default=None,
                        help="dist-tag to point at this version (default latest and next)")
    parser.add_argument("--otp", help="one-time password when the account has 2FA on publish")
    args = parser.parse_args()

    if args.tarball:
        tarball = args.tarball
    else:
        version = json.load(io.open(os.path.join(ROOT, "package.json"), encoding="utf-8"))["version"]
        tarball = os.path.join(ROOT, "dist", f"dsh-qgis-driver-{version}.tgz")
    if not os.path.exists(tarball):
        raise SystemExit(f"no tarball at {tarball} — run scripts/pack.mjs first")

    tags = args.tag or ["latest", "next"]
    document, data = build(tarball, tags)
    name = document["name"]
    version = next(iter(document["versions"]))
    body = json.dumps(document).encode("utf-8")

    print(f"{name}@{version}  tarball {len(data)} B  body {len(body)} B  tags {tags}")
    if args.dry_run:
        out = os.path.join(os.environ.get("TEMP", ROOT), "npm-publish-dry.json")
        io.open(out, "wb").write(json.dumps(document, indent=1).encode("utf-8"))
        print(f"dry run: nothing sent; document written to {out}")
        return 0

    request = urllib.request.Request(
        f"{REGISTRY}/{name}",
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "dsh-qgis-driver publisher",
            **({"npm-otp": args.otp} if args.otp else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            print(f"registry said {response.status}")
            print(response.read(400).decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        print(f"registry said {error.code}")
        print(error.read(1200).decode("utf-8", "replace"))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
