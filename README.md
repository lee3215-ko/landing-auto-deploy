# Landing Auto Deploy

Netlify / Cloudflare / 닷홈 사이트 생성 + 네이버 서치어드바이저 자동 등록 Windows 앱.

## 다운로드

최신 버전 zip:

**https://github.com/lee3215-ko/landing-auto-deploy/releases/latest/download/LandingAutoDeploy.zip**

릴리스 목록: https://github.com/lee3215-ko/landing-auto-deploy/releases

1. zip 압축 해제
2. `LandingAutoDeploy\Landing Auto Deploy.exe` 실행

## 자동 업데이트

앱 시작 시 GitHub `version.json`을 확인해 새 버전이 있으면 안내합니다.  
「예」를 누르면 zip을 받아 설치 폴더에 덮어쓰고 재실행합니다. (설정 데이터는 `%AppData%`에 보관)

## 개발

```bat
npm install
npm start
npm run dist:dir
```

배포:

```bat
deploy.bat
```
