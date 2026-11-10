"""ODD HR 추출 엔진 자동 채점.

실행: uv --directory "%LOCALAPPDATA%\\ODD-HR\\kakaotalk-mcp" run python <이 파일 경로>
또는 (개발용) python eval/자동-채점.py

판정(할 일 / 할 일 아님 / PM 확인 필요), 담당 역할, 마감을 기대값과 비교한다.
메시지 날짜가 CSV에 없으므로 기준일을 2026-11-10(화)로 둔다.
"""
from __future__ import annotations

import csv
import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for cand in (os.path.join(HERE, ".."), os.path.join(HERE, "..", "server")):
    if os.path.exists(os.path.join(cand, "oddhr_extract.py")):
        sys.path.insert(0, os.path.abspath(cand))
        break
try:
    from oddhr_extract import classify  # type: ignore
except ImportError:
    from kakaotalk_mcp.oddhr_extract import classify  # type: ignore

import re

REF = dt.date(2026, 11, 10)


def expected_due(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    monday = REF - dt.timedelta(days=REF.weekday())
    if s == "메시지 당일":
        return REF.isoformat()
    if s == "메시지 다음다음 날":
        return (REF + dt.timedelta(days=2)).isoformat()
    if s == "다음 주 일요일":
        return (monday + dt.timedelta(days=13)).isoformat()
    if s == "메시지 다음 날":
        return (REF + dt.timedelta(days=1)).isoformat()
    m = re.match(r"(이번|다음) 주 ([월화수목금토일])요일", s)
    if m:
        off = "월화수목금토일".index(m[2]) + (7 if m[1] == "다음" else 0)
        return (monday + dt.timedelta(days=off)).isoformat()
    m = re.match(r"(\d+)월 (\d+)일", s)
    if m:
        return dt.date(REF.year, int(m[1]), int(m[2])).isoformat()
    return None


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "카톡-할일-판정-예시.csv"
    path = os.path.join(HERE, name)
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    v_ok = r_ok = r_n = d_ok = d_n = 0
    wrong = []
    for row in rows:
        m = re.match(r"\[(?P<s>[^\]]+)\] \[(?P<t>[^\]]+)\] (?P<x>.*)", row["메시지"])
        msg = {"date": "", "sender": m["s"], "time": m["t"], "text": m["x"]}
        v = classify(msg, ref=REF)
        exp = row["기대 판정"]
        ok = v.verdict == exp
        v_ok += ok
        line = f'{row["번호"]:>2} {"O" if ok else "X"} 판정 {v.verdict} (기대 {exp})'
        if exp == "할 일" and v.verdict == "할 일":
            if row["기대 담당"]:
                r_n += 1
                r_ok += v.role == row["기대 담당"]
                line += f' | 담당 {v.role} (기대 {row["기대 담당"]})'
            ed = expected_due(row["기대 마감"])
            d_n += 1
            d_ok += (v.due == ed)
            line += f" | 마감 {v.due} (기대 {ed}) | 제목 '{v.title}' | 확신도 {v.confidence}{' | 고위험' if v.risky else ''}"
        else:
            line += f" | {v.reason}"
        print(line)
        if not ok:
            wrong.append(row["번호"])
    n = len(rows)
    print()
    print(f"판정 정확도 {v_ok}/{n} ({v_ok / n:.0%})")
    if r_n:
        print(f"담당 역할 {r_ok}/{r_n} ({r_ok / r_n:.0%})")
    if d_n:
        print(f"마감 날짜 {d_ok}/{d_n} ({d_ok / d_n:.0%})")
    if wrong:
        print("틀린 줄:", ", ".join(wrong))
    return 0


if __name__ == "__main__":
    sys.exit(main())
