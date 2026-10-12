# SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
# SPDX-License-Identifier: GPL-3.0-or-later

# Every schema the module can deploy: rime-data's, rime-loengfan's, and
# rime-ice's, which replace rime-data's of the same names. Each has an
# English gloss for its display name, the languages it types, the package it
# comes from, and the dictionary and dependencies its deployed config names,
# which the build needs before it deploys anything and checks against the
# deployed configs afterwards.
{
  array30 = {
    gloss = "Array 30";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30";
    dependencies = [
      "array30_wsymbols"
      "luna_quanpin"
    ];
    # Its wildcard lookup reads array30_query's dictionary, which its config
    # doesn't list as a dependency.
    undeclared = [ "array30_query" ];
  };
  array30_query = {
    # A helper with no punctuation, which Rime warns of when a session
    # opens it: a dependency, not an engine.
    engine = false;
    gloss = "Array 30, wildcard lookup";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30_query";
    dependencies = [ ];
  };
  array30_wsymbols = {
    # A helper with no punctuation, which Rime warns of when a session
    # opens it: a dependency, not an engine.
    engine = false;
    gloss = "Array 30, symbols";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "array30_wsymbols";
    dependencies = [ ];
  };
  bopomofo = {
    gloss = "Zhuyin";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  bopomofo_express = {
    gloss = "Zhuyin, express";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  bopomofo_tw = {
    gloss = "Zhuyin, Taiwan";
    languages = [ "zh-Hant-TW" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  cangjie5 = {
    gloss = "Cangjie 5";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "cangjie5";
    dependencies = [ "luna_quanpin" ];
  };
  cangjie5_express = {
    gloss = "Cangjie 5, express";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "cangjie5";
    dependencies = [ "luna_quanpin" ];
  };
  combo_pinyin = {
    gloss = "Combo Pinyin";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_10 = {
    gloss = "Combo Pinyin, ten fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_10_emacsen = {
    gloss = "Combo Pinyin, ten fingers, Emacs";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_8 = {
    gloss = "Combo Pinyin, eight fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_8_emacsen = {
    gloss = "Combo Pinyin, eight fingers, Emacs";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  combo_pinyin_9 = {
    gloss = "Combo Pinyin, nine fingers";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  double_pinyin = {
    gloss = "Double Pinyin, Ziranma";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_abc = {
    gloss = "Double Pinyin, Intelligent ABC";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_flypy = {
    gloss = "Double Pinyin, Xiaohe";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_jiajia = {
    gloss = "Double Pinyin, Pinyin Jiajia";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_mspy = {
    gloss = "Double Pinyin, Microsoft";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_pyjj = {
    gloss = "Double Pinyin, Pinyin Jiajia, traditional";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  double_pinyin_sogou = {
    gloss = "Double Pinyin, Sogou";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  double_pinyin_ziguang = {
    gloss = "Double Pinyin, Ziguang";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  hkcantonese = {
    gloss = "Cantonese, Hong Kong romanisation";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [ "luna_pinyin" ];
  };
  ipa_xsampa = {
    gloss = "IPA, X-SAMPA";
    languages = [ "und-fonipa" ];
    from = "rime-data";
    dictionary = "ipa_xsampa";
    dependencies = [ ];
  };
  ipa_yunlong = {
    gloss = "IPA, Yunlong";
    languages = [ "und-fonipa" ];
    from = "rime-data";
    dictionary = "ipa_yunlong";
    dependencies = [ ];
  };
  jyut6ping3 = {
    gloss = "Cantonese, Jyutping";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyut6ping3";
    dependencies = [
      "luna_pinyin"
      "loengfan"
      "stroke"
      "cangjie5"
    ];
  };
  jyut6ping3_ipa = {
    gloss = "Cantonese, Jyutping with IPA";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyut6ping3";
    dependencies = [
      "luna_pinyin"
      "loengfan"
      "stroke"
      "cangjie5"
    ];
  };
  jyutping = {
    gloss = "Cantonese, Jyutping without tones";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [
      "luna_pinyin"
      "stroke"
      "cangjie5"
    ];
  };
  loengfan = {
    # A dependency, not an engine.
    engine = false;
    gloss = "Cantonese, by two parts";
    languages = [ "yue" ];
    from = "rime-loengfan";
    dictionary = "loengfan";
    dependencies = [ "cangjie5" ];
  };
  luna_pinyin = {
    gloss = "Pinyin, traditional";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_fluency = {
    gloss = "Pinyin, traditional, sentences";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_simp = {
    gloss = "Pinyin, simplified characters";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_pinyin_tw = {
    gloss = "Pinyin, Taiwan";
    languages = [ "zh-Hant-TW" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  luna_quanpin = {
    gloss = "Pinyin, full";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ "stroke" ];
  };
  melt_eng = {
    # A dependency, not an engine.
    engine = false;
    gloss = "English";
    languages = [ "en" ];
    from = "rime-ice";
    dictionary = "melt_eng";
    dependencies = [ ];
  };
  pinyin_simp = {
    gloss = "Pinyin, simplified, compact";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "pinyin_simp";
    dependencies = [ "stroke" ];
  };
  quick5 = {
    gloss = "Quick";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "quick5";
    dependencies = [ "luna_quanpin" ];
  };
  radical_pinyin = {
    # A dependency, not an engine.
    engine = false;
    gloss = "Character components";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "radical_pinyin";
    dependencies = [ ];
  };
  rime_ice = {
    gloss = "Pinyin, simplified";
    languages = [ "zh-Hans" ];
    from = "rime-ice";
    dictionary = "rime_ice";
    dependencies = [
      "melt_eng"
      "radical_pinyin"
    ];
  };
  sampheng = {
    gloss = "Middle Chinese, three-part";
    languages = [ "ltc" ];
    from = "rime-data";
    dictionary = "zyenpheng";
    dependencies = [ "luna_pinyin" ];
  };
  scj6 = {
    gloss = "Quick Cangjie 6";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "scj6";
    dependencies = [ "luna_quanpin" ];
  };
  soutzoe = {
    gloss = "Wu, Suzhou";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "soutzoe";
    dependencies = [ "luna_pinyin" ];
  };
  stenotype = {
    gloss = "Stenotype";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "luna_pinyin";
    dependencies = [ ];
  };
  stroke = {
    gloss = "Strokes";
    languages = [ "zh" ];
    from = "rime-data";
    dictionary = "stroke";
    dependencies = [ "luna_pinyin" ];
  };
  terra_pinyin = {
    gloss = "Pinyin with tones";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "terra_pinyin";
    dependencies = [ "stroke" ];
  };
  wubi86 = {
    gloss = "Wubi 86";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wubi_pinyin = {
    gloss = "Wubi 86 and Pinyin";
    languages = [ "zh-Hans" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wubi_trad = {
    gloss = "Wubi 86, traditional output";
    languages = [ "zh-Hant" ];
    from = "rime-data";
    dictionary = "wubi86";
    dependencies = [ "pinyin_simp" ];
  };
  wugniu = {
    gloss = "Wu, Shanghai";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "wugniu_lopha";
    dependencies = [ "luna_pinyin" ];
  };
  wugniu_lopha = {
    gloss = "Wu, Shanghai, Lopha";
    languages = [ "wuu" ];
    from = "rime-data";
    dictionary = "wugniu_lopha";
    dependencies = [ "luna_pinyin" ];
  };
  yale = {
    gloss = "Cantonese, Yale";
    languages = [ "yue" ];
    from = "rime-data";
    dictionary = "jyutping";
    dependencies = [ "luna_pinyin" ];
  };
  zyenpheng = {
    gloss = "Middle Chinese";
    languages = [ "ltc" ];
    from = "rime-data";
    dictionary = "zyenpheng";
    dependencies = [ "luna_pinyin" ];
  };
}
