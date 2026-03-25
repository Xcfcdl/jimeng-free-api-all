#!/bin/bash
# 启动服务前彻底禁用所有代理

unset all_proxy
unset ALL_PROXY
unset http_proxy
unset HTTP_PROXY
unset https_proxy
unset HTTPS_PROXY
unset ftp_proxy
unset FTP_PROXY
unset rsync_proxy
unset RSYNC_PROXY

export no_proxy=*
export NO_PROXY=*

# 启动服务
npm start -- --port 8000
