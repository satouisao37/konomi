#!/usr/bin/env bash
set -euo pipefail

# このみのエクスポートを、ローカル認証済み LLM CLI に渡して分析する。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_REPORT_DIR="${KONOMI_REPORT_DIR:-$HOME/dev/vault/Tools/konomi/reports}"

usage() {
  cat >&2 <<'EOF'
使い方: bash tools/analyze_llm.sh [--dry-run] [-o 保存先ディレクトリ] <export.json> [codex|claude]
EOF
}

die() {
  printf 'エラー: %s\n' "$1" >&2
  exit 1
}

DRY_RUN=false
REPORT_DIR="$DEFAULT_REPORT_DIR"
INPUT=''
ENGINE='codex'
POSITIONALS=()

while (($#)); do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -o)
      (($# >= 2)) || { usage; die '-o には保存先ディレクトリを指定してください'; }
      REPORT_DIR="$2"
      shift 2
      ;;
    --)
      shift
      while (($#)); do POSITIONALS+=("$1"); shift; done
      ;;
    -*)
      usage
      die "未知のオプションです: $1"
      ;;
    *)
      POSITIONALS+=("$1")
      shift
      ;;
  esac
done

((${#POSITIONALS[@]} >= 1 && ${#POSITIONALS[@]} <= 2)) || { usage; die 'エクスポート JSON と、必要ならエンジンを指定してください'; }
INPUT="${POSITIONALS[0]}"
if ((${#POSITIONALS[@]} == 2)); then ENGINE="${POSITIONALS[1]}"; fi
[[ "$ENGINE" == 'codex' || "$ENGINE" == 'claude' ]] || { usage; die "未対応のエンジンです: $ENGINE"; }
[[ -f "$INPUT" && -r "$INPUT" ]] || die "入力ファイルを読み取れません: $INPUT"

python3 - "$INPUT" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding='utf-8') as f:
        parsed = json.load(f)
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
    print(f'エラー: JSON を読み取れません: {exc}', file=sys.stderr)
    sys.exit(1)

body = parsed.get('data') if isinstance(parsed, dict) and isinstance(parsed.get('data'), dict) else parsed
if not isinstance(body, dict) or body.get('app') != 'konomi' or not isinstance(body.get('items'), list):
    print('エラー: このみのエクスポートではありません(app が konomi、items が配列の本体が必要です)', file=sys.stderr)
    sys.exit(1)
PY

if python3 - "$INPUT" "$REPO_ROOT" <<'PY'
import os
import sys

source = os.path.realpath(sys.argv[1])
root = os.path.realpath(sys.argv[2])
try:
    inside = os.path.commonpath((source, root)) == root
except ValueError:
    inside = False
sys.exit(0 if inside else 1)
PY
then
  printf '警告: 入力 JSON がこの public リポジトリ配下にあります。実データはリポジトリに置かないでください。\n' >&2
fi

write_prompt() {
  cat "$SCRIPT_DIR/analyze_prompt.md"
  printf '\n\n## 分析対象のエクスポート JSON\n\n```json\n'
  cat "$INPUT"
  printf '\n```\n'
}

if [[ "$DRY_RUN" == true ]]; then
  write_prompt
  exit 0
fi

TMP_PROMPT=''
TMP_OUT=''
trap '[[ -z "$TMP_PROMPT" ]] || rm -f "$TMP_PROMPT"; [[ -z "$TMP_OUT" ]] || rm -f "$TMP_OUT"' EXIT
TMP_PROMPT="$(mktemp "${TMPDIR:-/tmp}/konomi-prompt.XXXXXX")"
TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/konomi-output.XXXXXX")"
write_prompt > "$TMP_PROMPT"

command -v "$ENGINE" >/dev/null 2>&1 || die "$ENGINE CLI が見つかりません。インストールしてから再実行してください"
if [[ "$ENGINE" == 'codex' ]]; then
  if ! codex exec --ephemeral --skip-git-repo-check -s read-only -o "$TMP_OUT" - < "$TMP_PROMPT" >/dev/null; then
    die 'codex による分析に失敗しました'
  fi
else
  if ! claude -p < "$TMP_PROMPT" > "$TMP_OUT"; then
    die 'claude による分析に失敗しました'
  fi
fi
[[ -s "$TMP_OUT" ]] || die "$ENGINE の出力が空です。レポートは保存しませんでした"

mkdir -p "$REPORT_DIR" || die "レポート保存先を作成できません: $REPORT_DIR"
STAMP="$(date '+%Y-%m-%d_%H-%M')"
REPORT_PATH="$REPORT_DIR/${STAMP}_人物分析.md"
NUMBER=2
while [[ -e "$REPORT_PATH" ]]; do
  REPORT_PATH="$REPORT_DIR/${STAMP}_人物分析_${NUMBER}.md"
  ((NUMBER += 1))
done

SOURCE_NAME="${INPUT##*/}"
SOURCE_YAML="$(python3 - "$SOURCE_NAME" <<'PY'
import json
import sys
print(json.dumps(sys.argv[1], ensure_ascii=False))
PY
)"
CREATED="$(date '+%Y-%m-%dT%H:%M:%S%z')"
{
  printf '%s\n' '---'
  printf '%s\n' 'tags: [konomi-report]'
  printf 'created: %s\n' "$CREATED"
  printf 'engine: %s\n' "$ENGINE"
  printf 'source: %s\n' "$SOURCE_YAML"
  printf '%s\n\n' '---'
  cat "$TMP_OUT"
} > "$REPORT_PATH"

printf 'レポートを保存しました: %s\n' "$REPORT_PATH"
