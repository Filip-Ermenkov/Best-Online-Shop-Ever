config {
  call_module_type = "all"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.47.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"

  # Force PGP signature verification. tflint's newer GitHub artifact-attestation
  # path panics (nil pointer in sigstore-go's bundle.TlogEntries) on this ruleset's
  # attestation bundle — upstream issue #2591, which reproduces on v0.62.1 AND
  # v0.63.1, so it is NOT fixed by bumping tflint. PGP still cryptographically
  # verifies the plugin (prints a legacy-signing-key deprecation warning). Remove
  # this line once #2591 is resolved upstream.
  signature = "pgp"
}
