"""Turn the single-file build into an Artifact page fragment (no doctype/html/head/body)."""
import re, sys
src = open(sys.argv[1]).read()
head = re.search(r'<head>(.*)</head>', src, re.S).group(1)
body = re.search(r'<body>(.*)</body>', src, re.S).group(1)
title = re.search(r'<title>.*?</title>', head, re.S).group(0)
links = ''.join(re.findall(r'<link[^>]*fonts\.(?:googleapis|gstatic)[^>]*>', head))
styles = ''.join(re.findall(r'<style[^>]*>.*?</style>', head, re.S))
scripts = ''.join(re.findall(r'<script[^>]*>.*?</script>', head, re.S))
meta = '<meta name="theme-color" content="#16130f">'
out = f'{title}\n{meta}\n{links}\n{styles}\n{body.strip()}\n{scripts}\n'
open(sys.argv[2], 'w').write(out)
print(len(out))
