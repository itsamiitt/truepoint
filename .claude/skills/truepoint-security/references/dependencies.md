# Dependency Security

Most of the code that runs in TruePoint is third-party — the npm dependency tree
is vast and deep. A vulnerability or a malicious package anywhere in that tree
runs with the same privileges as your own code. Supply-chain security is keeping
that tree trustworthy.

---

## The Lockfile Is Law

The lockfile (`bun.lock`) pins the exact version and integrity hash of every
package, direct and transitive. It is what makes installs reproducible and
tamper-evident.

- The lockfile is committed and is the source of truth for what gets installed.
- CI installs with a frozen lockfile (`bun install --frozen-lockfile`) so the build
  fails if `package.json` and the lockfile disagree — this catches an unreviewed
  dependency change.
- Never hand-edit the lockfile. Never delete and regenerate it casually — that can
  silently pull in new transitive versions. Regenerate it deliberately, and review
  the diff.

---

## Audit in CI

A vulnerability audit (`bun audit`, or `npm audit` against the same tree) runs in the
pipeline and surfaces known vulnerabilities in the dependency tree.

- Treat a new high/critical advisory as a thing to fix, not a warning to ignore.
- Fixing is usually updating the affected package to a patched version; sometimes
  it is replacing an unmaintained package.
- Don't blanket-suppress advisories to make the build green. If an advisory is
  genuinely not applicable, document why — but the default is to fix it.

---

## Vet New Dependencies Before Adding

Adding a dependency adds everything it depends on, and grants all of it the
ability to run code in your build and (if it reaches the client bundle) in users'
browsers. Adding a package is a trust decision, not a convenience.

Before adding a dependency, consider:
- **Is it needed?** Could a few lines of your own code replace it? The smallest
  dependency tree is the most secure one. A one-function package is rarely worth
  the supply-chain surface.
- **Is it maintained and reputable?** Recent releases, real usage, a credible
  maintainer. An abandoned or obscure package is a risk — unpatched vulnerabilities
  and a takeover target.
- **What does it pull in?** A package with a huge transitive tree brings a huge
  attack surface. Check what comes with it.
- **Does it run install scripts?** Postinstall scripts execute arbitrary code on
  every install, including in CI. Be cautious with packages that use them.

Prefer well-established, widely-used packages over novel ones for anything
security-relevant. Never add a package you can't account for.

---

## Client Bundle Awareness

A dependency added to app code may ship to the browser, increasing both bundle
size and client-side attack surface. A package that only needs to run server-side
should not be imported into client code where it would be bundled and shipped.
Keep server-only dependencies out of the client tree.

---

## Keep Dependencies Current

- Apply security updates promptly — an old version with a known CVE is a known
  open door.
- Update deliberately and in focused changes (see the architecture commit/PR
  conventions), reviewing the diff and the changelog, not in a giant unreviewed bump.
- Pin to versions the lockfile records; don't float on `latest` or wide ranges
  that can pull in an unreviewed (or compromised) release.

---

## Checklist

- Is the lockfile (`bun.lock`) committed, and does CI install with
  `bun install --frozen-lockfile`?
- Does a dependency audit (`bun audit` / `npm audit`) run in CI, and are high/critical
  advisories fixed not ignored?
- Was every new dependency vetted for need, maintenance, transitive tree, and install scripts?
- Are server-only dependencies kept out of the client bundle?
- Are security updates applied promptly, in reviewed changes?
