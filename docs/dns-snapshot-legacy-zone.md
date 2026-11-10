# DNS snapshot — finestkindfarms.com

Captured 2026-08-03, **before** any nameserver change, from Namecheap's
nameservers (`dns1.registrar-servers.com`, `dns2.registrar-servers.com`).

Purpose: the domain hosts a **live Namecheap Private Email mailbox**. Moving
nameservers to Cloudflare will silently break inbound mail if any of these
records fail to carry over. Verify every one of them in Cloudflare's DNS table
*before* changing nameservers at Namecheap, and again after propagation.

## Must preserve — email

| Type | Name | Value |
|---|---|---|
| MX | `@` | `mx1.privateemail.com` (priority 10) |
| MX | `@` | `mx2.privateemail.com` (priority 10) |
| TXT | `@` | `v=spf1 include:spf.privateemail.com ~all` |
| CNAME | `mail` | `privateemail.com` |
| TXT | `mail` | `v=spf1 include:spf-nc.privateemail.com include:spf-ep-nc.jellyfish.systems -all` |
| CNAME | `autodiscover` | `privateemail.com` |
| CNAME | `autoconfig` | `privateemail.com` |
| TXT | `autodiscover` | `google-site-verification=PfY0lyNaWDFXDYY1LJnJVtqDTuwBAKPfPu0brQdnUYA` |
| TXT | `autoconfig` | `google-site-verification=U7HaXt95Ldm2wLdsiC78Pe9SJzW65QiA2Hdo63hdjAI` |

**DKIM** — `default._domainkey` TXT. Cloudflare's importer is least reliable
here because the value is published as two concatenated strings:

```
"v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt3Oh8j/zDhx4vx7eozIvnHM1fYvWTvWfwugCaqfMKaBMQKPM9posK2NoxJOoFNiGAP7ZYSanTuHGg6udA0C4B9q4osr3j9l88bZlE0O/vo8Z5/tq5XJwrEt96I+M2augSPcCKBh/g490Oq42I918lw6uAC3CK/iW4WWENWE3IWtSxoP0yHTkV3AEcIOT44MBzVM"
"hR7oa7H4407pupJxihpMS2GOJW5KU5RM9GswW5lA78PMNCUEFp/+zduWC8okwAoq++69DaXnzti0+1BMkuo2OM1ghoPePt7bcbM1haFIb2QbwsK+pW0GBniYDD/gYgp1lL0eBPYW7auJKM+Db3wIDAQAB"
```

No `_dmarc` record exists. Not required; worth adding later, unrelated to this.

## Safe to drop

Namecheap parking pages, of no value:

| Type | Name | Value |
|---|---|---|
| A | `@` | `192.64.119.38` |
| CNAME/A | `www` | `parkingpage.namecheap.com` / `72.251.11.125`, `72.251.11.93` |

## Verification after the move

```bash
# Every one of these must match the table above.
dig +short MX finestkindfarms.com
dig +short TXT finestkindfarms.com
dig +short default._domainkey.finestkindfarms.com TXT
for s in mail autodiscover autoconfig; do dig +short $s.finestkindfarms.com; done
```

Then send a real message to the live mailbox and confirm it arrives. DNS
lookups matching is necessary but not sufficient.
