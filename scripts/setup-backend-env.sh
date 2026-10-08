#!/bin/bash
# 在云端重建整套后端运行环境的完整脚本。
# 沙箱会被回收，这个脚本是「从零到能跑 HTTP 端到端」的可复现路径。
set -u
export DEBIAN_FRONTEND=noninteractive
export DEBIAN_PRIORITY=noninteractive

log() { echo "=== $* ==="; }
die() { echo "!!! $*"; exit 1; }

# ── 0. apt 源 ──────────────────────────────────────────────────────
# ⚠️ 环境里预配的是 mirrors.cloud.aliyuncs.com，那个域名实测**完全不通**（连接即失败），
#    导致 apt 缓存只有 2374 个包、装不上任何东西。
#    mirrors.aliyun.com 实测 13MB/s，用 HTTP（https 在沙箱里证书验证失败）。
cat > /etc/apt/sources.list.d/debian.sources <<'EOF'
Types: deb
URIs: http://mirrors.aliyun.com/debian
Suites: bookworm bookworm-updates
Components: main contrib non-free
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://mirrors.aliyun.com/debian-security
Suites: bookworm-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
pkill -9 apt-get 2>/dev/null
rm -rf /var/lib/apt/lists/*
log "apt-get update"
apt-get update -o Acquire::Retries=5 -o Acquire::http::Timeout=60 -qq || die "apt update"
echo "  包数: $(apt-cache stats 2>/dev/null | awk '/Total package names/{print $4}')"

# ── 1. PHP 8.2 + 扩展 ──────────────────────────────────────────────
log "安装 PHP 8.2 与扩展"
apt-get install -y -qq --no-install-recommends \
  php8.2-cli php8.2-mbstring php8.2-xml php8.2-curl php8.2-mysql php8.2-redis \
  php8.2-bcmath php8.2-zip php8.2-dev php-pear \
  build-essential pkg-config git unzip ca-certificates gnupg || die "PHP 安装"
php -v | head -1

# ── 2. Swoole（co-phpunit 依赖）────────────────────────────────────
log "编译 Swoole（几分钟）"
if ! php -m | grep -q swoole; then
  printf "\n" | pecl install swoole >/tmp/swoole-build.log 2>&1
  echo "extension=swoole.so" > /etc/php/8.2/mods-available/swoole.ini
  phpenmod swoole 2>/dev/null
fi
php -m | grep -qi swoole && echo "  ✓ swoole $(php -r 'echo phpversion("swoole");')" || { tail -20 /tmp/swoole-build.log; die "swoole"; }

# ── 3. MySQL 8.0.46 ───────────────────────────────────────────────
log "安装 MySQL 8"
printf 'deb [trusted=yes] http://repo.mysql.com/apt/debian/ bookworm mysql-8.0\n' > /etc/apt/sources.list.d/mysql.list
apt-get update -o Acquire::Retries=3 -qq 2>/dev/null
if ! command -v mysqld >/dev/null; then
  apt-get install -y -qq mysql-community-server || die "MySQL 安装"
fi
mysqld --version

log "启动 MySQL"
mkdir -p /var/run/mysqld && chown mysql:mysql /var/run/mysqld
nohup mysqld_safe --user=mysql >/tmp/mysqld.log 2>&1 &
for i in $(seq 1 40); do mysqladmin ping >/dev/null 2>&1 && break; sleep 3; done
mysqladmin ping >/dev/null 2>&1 || die "MySQL 起不来"

# ⚠️ MySQL 8 的 root 默认走 auth_socket：**只有走 unix socket 的 mysql 客户端能连上**，
#    应用用 PDO 走 TCP（127.0.0.1），会被拒：
#      Access denied for user 'root'@'localhost' (SQLSTATE 1698)
#    这个坑会让「装好了但连不上」，而且 CLI 一测又正常，极易误判成环境好了。
#    所以这里**必须显式改成 native_password，并当场用 TCP 验证**，不验证不算成功。
mysql -uroot -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'rootpw'; FLUSH PRIVILEGES;" 2>/dev/null \
  || mysql -uroot -prootpw -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'rootpw'; FLUSH PRIVILEGES;" 2>/dev/null \
  || true

if ! mysql -uroot -prootpw -h 127.0.0.1 -e "SELECT 1" >/dev/null 2>&1; then
  die "MySQL TCP 认证不通（应用会全部 500）。请手动执行：ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'rootpw';"
fi
echo "  ✓ MySQL TCP 认证已验证"
mysql -uroot -prootpw -h 127.0.0.1 -e "SELECT VERSION() v" 2>/dev/null | tail -1

# ── 4. Redis ──────────────────────────────────────────────────────
log "安装 Redis"
apt-get install -y -qq --no-install-recommends redis-server || die "Redis 安装"
nohup redis-server --daemonize no --save '' >/tmp/redis.log 2>&1 &
for i in $(seq 1 20); do redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 2; done
redis-cli ping 2>/dev/null | sed 's/^/  redis: /' || die "Redis 起不来"

# ── 5. Composer + 依赖 ────────────────────────────────────────────
log "Composer + composer install"
if ! command -v composer >/dev/null; then
  curl -sS -o /tmp/composer-setup.php https://getcomposer.org/installer \
    && php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
fi
composer --version 2>&1 | head -1

cd /workspace/server || die "没有 /workspace/server"
[ -f .env ] || cat > .env <<'EOF'
APP_ENV=dev
APP_NAME=alarm-server
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=alarm
DB_USERNAME=root
DB_PASSWORD=rootpw
DB_CHARSET=utf8mb4
DB_COLLATION=utf8mb4_0900_ai_ci
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
CACHE_DRIVER=default
ALARM_STATIC_TOKENS=e2e-token-for-local-test-only
ALARM_AUTH_DISABLED=false
ALARM_CURRENT_USER=端到端测试
SERVER_PORT=9501
EOF
COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --prefer-dist -q 2>&1 | tail -5
[ -f vendor/autoload.php ] && echo "  ✓ vendor 就绪"

# ── 6. 建库 + 迁移 ────────────────────────────────────────────────
log "建库 + 执行迁移"
mysql -uroot -prootpw -e "CREATE DATABASE IF NOT EXISTS alarm DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
php run-migrations.php 2>&1 | tail -3

log "环境就绪"
