#!/bin/sh
set -eu
# The upstream entrypoint writes into /usr/local/etc, which is read-only here.
# Keep the immutable template and write only the generated config into tmpfs.
sed 's/${BIND_CONFIG}/:2375/g' /usr/local/etc/haproxy/haproxy.cfg.template > /tmp/haproxy.cfg
exec haproxy -W -db -f /tmp/haproxy.cfg
