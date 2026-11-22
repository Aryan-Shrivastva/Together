FROM tecnativa/docker-socket-proxy:0.3.0
COPY docker-proxy/entrypoint.sh /usr/local/bin/together-proxy-entrypoint.sh
RUN chmod 755 /usr/local/bin/together-proxy-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/together-proxy-entrypoint.sh"]
