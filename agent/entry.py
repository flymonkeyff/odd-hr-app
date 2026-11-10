"""ODD HR 앱에 들어가는 카톡 에이전트 실행 파일 진입점 (PyInstaller로 odd-hr-agent.exe를 만든다)."""
import sys

from kakaotalk_mcp.oddhr_agent import main

if __name__ == "__main__":
    sys.exit(main())
