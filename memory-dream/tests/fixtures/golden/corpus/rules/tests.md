# Test execution

- verification_run forwards the host PATH to node:test and withholds HOME by default.
- spawn-based tests can find executables through the forwarded PATH.
- The full HOME environment is not passed to tests unless forwardHome is set.
