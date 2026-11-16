# dsh_qgis_driver — Full Logic Sheet

- Type: qgis_plugin / Version: 0.16.1
- Generated: 2026-11-15T22:33:28+09:00 / Features: 179

## Topology

```mermaid
flowchart LR
  subgraph ENTRY["Operation entry"]
    UI["Menu/Dialog"]
    AI["AI/bridge_call"]
  end
  subgraph LOGIC["Implementation"]
    entry_point___init___py_classFactory["classFactory<br/><i>entry_point</i>"]
    action_GeoDriverPlugin_initGui["initGui<br/><i>action</i>"]
    action_GeoDriverPlugin_unload["unload<br/><i>action</i>"]
    action__GenericBridge_openDialog["openDialog<br/><i>action</i>"]
    action__GenericBridge_run["run<br/><i>action</i>"]
    dialog_AiPanel["AiPanel<br/><i>dialog</i>"]
    dialog__InstructionsDialog["_InstructionsDialog<br/><i>dialog</i>"]
    dialog__McpDialog["_McpDialog<br/><i>dialog</i>"]
    ui_AiPanel__on_agent_activated["_on_agent_activated<br/><i>ui_control</i>"]
    ui_AiPanel__on_agent_changed["_on_agent_changed<br/><i>ui_control</i>"]
    ui_AiPanel__on_confirm["_on_confirm<br/><i>ui_control</i>"]
    ui_AiPanel__on_destroyed["_on_destroyed<br/><i>ui_control</i>"]
    ui_AiPanel__on_model_activated["_on_model_activated<br/><i>ui_control</i>"]
    ui_AiPanel__on_model_text_changed["_on_model_text_changed<br/><i>ui_control</i>"]
    ui_AiPanel__on_models["_on_models<br/><i>ui_control</i>"]
    ui_AiPanel__on_pasted_images["_on_pasted_images<br/><i>ui_control</i>"]
    ui_AiPanel__on_prompt_activated["_on_prompt_activated<br/><i>ui_control</i>"]
    ui_AiPanel__on_provider_changed["_on_provider_changed<br/><i>ui_control</i>"]
    ui_AiPanel__on_settings_toggled["_on_settings_toggled<br/><i>ui_control</i>"]
    ui_AiPanel__on_signin["_on_signin<br/><i>ui_control</i>"]
    ui_GeoDriverPlugin__on_toggle["_on_toggle<br/><i>ui_control</i>"]
    bridge_applyScaleWidth["applyScaleWidth<br/><i>bridge_method</i>"]
    bridge_deployMode["deployMode<br/><i>bridge_method</i>"]
    bridge_hotReload["hotReload<br/><i>bridge_method</i>"]
    bridge_layerOrgProfiles["layerOrgProfiles<br/><i>bridge_method</i>"]
    bridge_layerOrgRules["layerOrgRules<br/><i>bridge_method</i>"]
    bridge_listDevPlugins["listDevPlugins<br/><i>bridge_method</i>"]
    bridge_openAiPanel["openAiPanel<br/><i>bridge_method</i>"]
    bridge_openConnInfo["openConnInfo<br/><i>bridge_method</i>"]
    bridge_openDeployMode["openDeployMode<br/><i>bridge_method</i>"]
    bridge_organizeLayers["organizeLayers<br/><i>bridge_method</i>"]
    bridge_placeLayer["placeLayer<br/><i>bridge_method</i>"]
    bridge_pluginInfo["pluginInfo<br/><i>bridge_method</i>"]
    bridge_remoteControl["remoteControl<br/><i>bridge_method</i>"]
    bridge_scaleStyleProfiles["scaleStyleProfiles<br/><i>bridge_method</i>"]
    bridge_scaleStyleTable["scaleStyleTable<br/><i>bridge_method</i>"]
    bridge_setLayerOrgProfile["setLayerOrgProfile<br/><i>bridge_method</i>"]
    bridge_setScaleStyleProfile["setScaleStyleProfile<br/><i>bridge_method</i>"]
    bridge_status["status<br/><i>bridge_method</i>"]
    bridge_suggestScaleWidth["suggestScaleWidth<br/><i>bridge_method</i>"]
    registry_ai_client_py_register_extra_tools["register_extra_tools<br/><i>registry</i>"]
    integration___init___py_59["subprocess.run<br/><i>integration</i>"]
    integration_ai_client_py_2102["HTTPServer<br/><i>integration</i>"]
    integration_ai_client_py_2108["HTTPServer<br/><i>integration</i>"]
    integration_ai_client_py_2125["webbrowser.open<br/><i>integration</i>"]
    integration_ai_client_py_2144["HTTPServer<br/><i>integration</i>"]
    integration_ai_client_py_2150["HTTPServer<br/><i>integration</i>"]
    integration_ai_client_py_2167["webbrowser.open<br/><i>integration</i>"]
    integration_ai_client_py_2302["subprocess.Popen<br/><i>integration</i>"]
    integration_ai_client_py_2344["subprocess.Popen<br/><i>integration</i>"]
    integration_ai_panel_py_2279["QDesktopServices.openUrl<br/><i>integration</i>"]
    integration_ai_panel_py_2293["QDesktopServices.openUrl<br/><i>integration</i>"]
    integration_ai_panel_py_492["QDesktopServices.openUrl<br/><i>integration</i>"]
    integration_ai_panel_py_504["QDesktopServices.openUrl<br/><i>integration</i>"]
    integration_credential_store_py_153["subprocess.run<br/><i>integration</i>"]
    integration_credential_store_py_180["subprocess.run<br/><i>integration</i>"]
    integration_credential_store_py_68["subprocess.run<br/><i>integration</i>"]
    integration_devin_tasks_py_274["subprocess.Popen<br/><i>integration</i>"]
    integration_devin_tasks_py_279["subprocess.Popen<br/><i>integration</i>"]
    integration_devin_tasks_py_639["subprocess.Popen<br/><i>integration</i>"]
    integration_devin_tasks_py_647["subprocess.Popen<br/><i>integration</i>"]
    integration_mcp_http_py_664["ThreadingHTTPServer<br/><i>integration</i>"]
    integration_mode_switch_py_225["subprocess.run<br/><i>integration</i>"]
    ai_bridge_route["Reached entirely via bridge_call<br/><i>ai_integration</i>"]
    ai_catalog["Registered in describe_plugins<br/><i>ai_integration</i>"]
    ai_pluginInfo["pluginInfo self-description<br/><i>ai_integration</i>"]
    logic_fn_ai_client_py_agents_dir["agents_dir<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_content["anthropic_content<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_headers["anthropic_headers<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_image_part["anthropic_image_part<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_messages["anthropic_messages<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_messages_url["anthropic_messages_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_models_url["anthropic_models_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_anthropic_tools["anthropic_tools<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_attachment_temp_path["attachment_temp_path<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_azure_chat_url["azure_chat_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_azure_resource_url["azure_resource_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_chat_completions["chat_completions<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_classify_model["classify_model<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_close_acp_sessions["close_acp_sessions<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_command_from_tool_call["command_from_tool_call<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_copilot_session["copilot_session<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_delete_agent["delete_agent<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_delete_instruction["delete_instruction<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_delete_skill["delete_skill<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_endpoint_url["endpoint_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_fmt_tokens["fmt_tokens<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_gemini_generate["gemini_generate<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_gemini_models_url["gemini_models_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_gemini_tools["gemini_tools<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_gemini_url["gemini_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_get_provider["get_provider<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_github_device_code["github_device_code<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_github_poll_access_token["github_poll_access_token<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_image_b64["image_b64<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_image_inline_part["image_inline_part<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_image_message_content["image_message_content<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_image_url_part["image_url_part<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_agents["list_agents<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_instruction_files["list_instruction_files<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_model_infos["list_model_infos<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_models["list_models<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_prompts["list_prompts<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_list_skills["list_skills<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_load_agent["load_agent<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_load_instruction["load_instruction<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_mcp_config_path["mcp_config_path<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_mcp_discover["mcp_discover<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_mcp_save_config["mcp_save_config<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_mcp_servers_config["mcp_servers_config<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_model_info["model_info<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_model_label["model_label<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_model_tooltip["model_tooltip<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_openai_models_url["openai_models_url<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_openai_msgs_to_responses_input["openai_msgs_to_responses_input<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_openai_tools["openai_tools<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_parse_responses_output["parse_responses_output<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_parse_tool_arguments["parse_tool_arguments<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_parse_usage["parse_usage<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_prompt_body["prompt_body<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_prompts_dir["prompts_dir<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_provider_defaults["provider_defaults<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_reply_to_text["reply_to_text<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_responses_create["responses_create<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_responses_tools["responses_tools<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_run_extra_tool["run_extra_tool<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_run_instruction_tool["run_instruction_tool<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_save_agent["save_agent<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_save_instruction["save_instruction<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_save_skill["save_skill<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_screenshot_temp_path["screenshot_temp_path<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_skills_dir["skills_dir<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_system_prompt["system_prompt<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_tool_to_command["tool_to_command<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_tr_label["tr_label<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_trim_history["trim_history<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_usage_cost["usage_cost<br/><i>logic_fn</i>"]
    logic_fn_ai_client_py_user_content["user_content<br/><i>logic_fn</i>"]
    logic_fn_ai_panel_py_show_panel["show_panel<br/><i>logic_fn</i>"]
    logic_fn_connection_info_py_build_sections["build_sections<br/><i>logic_fn</i>"]
    logic_fn_connection_info_py_show_dialog["show_dialog<br/><i>logic_fn</i>"]
    logic_fn_credential_store_py_backend["backend<br/><i>logic_fn</i>"]
    logic_fn_credential_store_py_backend_label["backend_label<br/><i>logic_fn</i>"]
    logic_fn_credential_store_py_delete_secret["delete_secret<br/><i>logic_fn</i>"]
    logic_fn_credential_store_py_get_secret["get_secret<br/><i>logic_fn</i>"]
    logic_fn_credential_store_py_set_secret["set_secret<br/><i>logic_fn</i>"]
    logic_fn_devin_tasks_py_abort["abort<br/><i>logic_fn</i>"]
    logic_fn_devin_tasks_py_find_exe["find_exe<br/><i>logic_fn</i>"]
    logic_fn_devin_tasks_py_result["result<br/><i>logic_fn</i>"]
    logic_fn_devin_tasks_py_run["run<br/><i>logic_fn</i>"]
    logic_fn_devin_tasks_py_status["status<br/><i>logic_fn</i>"]
    logic_fn_geo_toolbar_py_geo_suite_toolbar["geo_suite_toolbar<br/><i>logic_fn</i>"]
    logic_fn_hot_reload_py_dev_plugin_ids["dev_plugin_ids<br/><i>logic_fn</i>"]
    logic_fn_hot_reload_py_reload_plugins["reload_plugins<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_layer_attrs["layer_attrs<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_list_profiles["list_profiles<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_load_profile["load_profile<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_match_rule["match_rule<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_profiles_dir["profiles_dir<br/><i>logic_fn</i>"]
    logic_fn_layer_org_py_render_template["render_template<br/><i>logic_fn</i>"]
    logic_fn_live_driver_py_reload_plugin_now["reload_plugin_now<br/><i>logic_fn</i>"]
    logic_fn_mcp_http_py_start_http["start_http<br/><i>logic_fn</i>"]
    logic_fn_mcp_stdio_py_main["main<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_deploy_state["deploy_state<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_managed_ids["managed_ids<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_profile_root["profile_root<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_read_marker["read_marker<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_repo_root["repo_root<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_set_repo_path["set_repo_path<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_show_dialog["show_dialog<br/><i>logic_fn</i>"]
    logic_fn_mode_switch_py_switch_mode["switch_mode<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_band_for_scale["band_for_scale<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_list_profiles["list_profiles<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_load_profile["load_profile<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_match_category["match_category<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_mm_to_meters["mm_to_meters<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_profiles_dir["profiles_dir<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_renderer_symbols["renderer_symbols<br/><i>logic_fn</i>"]
    logic_fn_scale_style_py_suggested_mm["suggested_mm<br/><i>logic_fn</i>"]
  end
  AI --> bridge_applyScaleWidth & bridge_deployMode & bridge_hotReload & bridge_layerOrgProfiles & bridge_layerOrgRules & bridge_listDevPlugins & bridge_openAiPanel & bridge_openConnInfo …
  UI --> action_GeoDriverPlugin_initGui & action_GeoDriverPlugin_unload & action__GenericBridge_openDialog & action__GenericBridge_run & dialog_AiPanel & dialog__InstructionsDialog & dialog__McpDialog & ui_AiPanel__on_agent_activated …
  LOGIC --> QGIS["QGIS API / iface / QgsProject"]
  LOGIC --> EXT["External integrations (HTTP/subprocess/file)"]
```

## Per-feature logic

### entry_point.__init__.py:classFactory — classFactory

- kind: `entry_point` / source: `__init__.py:786`
- signature: `classFactory(iface)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_entry_point___init___py_classFactory["QGIS startup"] --> H_entry_point___init___py_classFactory["classFactory"]
  H_entry_point___init___py_classFactory --> R_entry_point___init___py_classFactory["QGIS/Runtime API"]
  R_entry_point___init___py_classFactory --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — classFactory→plugin loaded

### action.GeoDriverPlugin.initGui — initGui

- kind: `action` / source: `__init__.py:239`
- signature: `initGui()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_action_GeoDriverPlugin_initGui["Menu/Toolbar"] --> H_action_GeoDriverPlugin_initGui["initGui"]
  H_action_GeoDriverPlugin_initGui --> R_action_GeoDriverPlugin_initGui["QGIS/Runtime API"]
  R_action_GeoDriverPlugin_initGui --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call/generic trigger → existence check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### action.GeoDriverPlugin.unload — unload

- kind: `action` / source: `__init__.py:685`
- signature: `unload()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_action_GeoDriverPlugin_unload["Menu/Toolbar"] --> H_action_GeoDriverPlugin_unload["unload"]
  H_action_GeoDriverPlugin_unload --> R_action_GeoDriverPlugin_unload["QGIS/Runtime API"]
  R_action_GeoDriverPlugin_unload --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call/generic trigger → existence check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### action._GenericBridge.openDialog — openDialog

- kind: `action` / source: `live_driver.py:260`
- signature: `openDialog()`
- Summary: Show the widget of the dialog/dlg/dockwidget attribute.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_action__GenericBridge_openDialog["Menu/Toolbar"] --> H_action__GenericBridge_openDialog["openDialog"]
  H_action__GenericBridge_openDialog --> R_action__GenericBridge_openDialog["QGIS/Runtime API"]
  R_action__GenericBridge_openDialog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call/generic trigger → existence check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### action._GenericBridge.run — run

- kind: `action` / source: `live_driver.py:252`
- signature: `run()`
- Summary: Run plugin.run() asynchronously.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_action__GenericBridge_run["Menu/Toolbar"] --> H_action__GenericBridge_run["run"]
  H_action__GenericBridge_run --> R_action__GenericBridge_run["QGIS/Runtime API"]
  R_action__GenericBridge_run --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call/generic trigger → existence check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### dialog.AiPanel — AiPanel

- kind: `dialog` / source: `ai_panel.py:166`
- signature: `AiPanel`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_dialog_AiPanel["UI operation"] --> H_dialog_AiPanel["AiPanel"]
  H_dialog_AiPanel --> R_dialog_AiPanel["QGIS/Runtime API"]
  R_dialog_AiPanel --> OUT["Result"]
```

- Verification: Standalone= / Integrated=openDialog→screenshot→closeDialog
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### dialog._InstructionsDialog — _InstructionsDialog

- kind: `dialog` / source: `ai_panel.py:2005`
- signature: `_InstructionsDialog`
- Summary: Dialog for creating / editing / deleting instruction files (*.md under agents|skills).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_dialog__InstructionsDialog["UI operation"] --> H_dialog__InstructionsDialog["_InstructionsDialog"]
  H_dialog__InstructionsDialog --> R_dialog__InstructionsDialog["QGIS/Runtime API"]
  R_dialog__InstructionsDialog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=openDialog→screenshot→closeDialog
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### dialog._McpDialog — _McpDialog

- kind: `dialog` / source: `ai_panel.py:1897`
- signature: `_McpDialog`
- Summary: Editing of the external MCP server settings (~/.qgis-live/mcp_servers.json).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_dialog__McpDialog["UI operation"] --> H_dialog__McpDialog["_McpDialog"]
  H_dialog__McpDialog --> R_dialog__McpDialog["QGIS/Runtime API"]
  R_dialog__McpDialog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=openDialog→screenshot→closeDialog
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_agent_activated — _on_agent_activated

- kind: `ui_control` / source: `ai_panel.py:574`
- signature: `_on_agent_activated(_idx)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_agent_activated["UI signal"] --> H_ui_AiPanel__on_agent_activated["_on_agent_activated"]
  H_ui_AiPanel__on_agent_activated --> R_ui_AiPanel__on_agent_activated["QGIS/Runtime API"]
  R_ui_AiPanel__on_agent_activated --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_agent_changed — _on_agent_changed

- kind: `ui_control` / source: `ai_panel.py:691`
- signature: `_on_agent_changed(aid)`
- Summary: The selected agent was switched via the AI's ai_select_agent.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_agent_changed["UI signal"] --> H_ui_AiPanel__on_agent_changed["_on_agent_changed"]
  H_ui_AiPanel__on_agent_changed --> R_ui_AiPanel__on_agent_changed["QGIS/Runtime API"]
  R_ui_AiPanel__on_agent_changed --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_confirm — _on_confirm

- kind: `ui_control` / source: `ai_panel.py:1884`
- signature: `_on_confirm(name, args_text)`
- Summary: Show a confirmation dialog (GUI thread).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_confirm["UI signal"] --> H_ui_AiPanel__on_confirm["_on_confirm"]
  H_ui_AiPanel__on_confirm --> R_ui_AiPanel__on_confirm["QGIS/Runtime API"]
  R_ui_AiPanel__on_confirm --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_destroyed — _on_destroyed

- kind: `ui_control` / source: `ai_panel.py:1318`
- signature: `_on_destroyed()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_destroyed["UI signal"] --> H_ui_AiPanel__on_destroyed["_on_destroyed"]
  H_ui_AiPanel__on_destroyed --> R_ui_AiPanel__on_destroyed["QGIS/Runtime API"]
  R_ui_AiPanel__on_destroyed --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_model_activated — _on_model_activated

- kind: `ui_control` / source: `ai_panel.py:927`
- signature: `_on_model_activated(idx)`
- Summary: On item selection, leave only the undecorated ID in the line edit.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_model_activated["UI signal"] --> H_ui_AiPanel__on_model_activated["_on_model_activated"]
  H_ui_AiPanel__on_model_activated --> R_ui_AiPanel__on_model_activated["QGIS/Runtime API"]
  R_ui_AiPanel__on_model_activated --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_model_text_changed — _on_model_text_changed

- kind: `ui_control` / source: `ai_panel.py:933`
- signature: `_on_model_text_changed(_text)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_model_text_changed["UI signal"] --> H_ui_AiPanel__on_model_text_changed["_on_model_text_changed"]
  H_ui_AiPanel__on_model_text_changed --> R_ui_AiPanel__on_model_text_changed["QGIS/Runtime API"]
  R_ui_AiPanel__on_model_text_changed --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_models — _on_models

- kind: `ui_control` / source: `ai_panel.py:1360`
- signature: `_on_models(infos, error)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_models["UI signal"] --> H_ui_AiPanel__on_models["_on_models"]
  H_ui_AiPanel__on_models --> R_ui_AiPanel__on_models["QGIS/Runtime API"]
  R_ui_AiPanel__on_models --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_pasted_images — _on_pasted_images

- kind: `ui_control` / source: `ai_panel.py:1130`
- signature: `_on_pasted_images(sources)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_pasted_images["UI signal"] --> H_ui_AiPanel__on_pasted_images["_on_pasted_images"]
  H_ui_AiPanel__on_pasted_images --> R_ui_AiPanel__on_pasted_images["QGIS/Runtime API"]
  R_ui_AiPanel__on_pasted_images --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_prompt_activated — _on_prompt_activated

- kind: `ui_control` / source: `ai_panel.py:634`
- signature: `_on_prompt_activated(idx)`
- Summary: Recommended-prompt selection → insert the body into the input field.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_prompt_activated["UI signal"] --> H_ui_AiPanel__on_prompt_activated["_on_prompt_activated"]
  H_ui_AiPanel__on_prompt_activated --> R_ui_AiPanel__on_prompt_activated["QGIS/Runtime API"]
  R_ui_AiPanel__on_prompt_activated --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_provider_changed — _on_provider_changed

- kind: `ui_control` / source: `ai_panel.py:851`
- signature: `_on_provider_changed(_idx)`
- Summary: Save the previous provider's input values, then load the new provider's values.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_provider_changed["UI signal"] --> H_ui_AiPanel__on_provider_changed["_on_provider_changed"]
  H_ui_AiPanel__on_provider_changed --> R_ui_AiPanel__on_provider_changed["QGIS/Runtime API"]
  R_ui_AiPanel__on_provider_changed --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_settings_toggled — _on_settings_toggled

- kind: `ui_control` / source: `ai_panel.py:547`
- signature: `_on_settings_toggled(on)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_settings_toggled["UI signal"] --> H_ui_AiPanel__on_settings_toggled["_on_settings_toggled"]
  H_ui_AiPanel__on_settings_toggled --> R_ui_AiPanel__on_settings_toggled["QGIS/Runtime API"]
  R_ui_AiPanel__on_settings_toggled --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.AiPanel._on_signin — _on_signin

- kind: `ui_control` / source: `ai_panel.py:1436`
- signature: `_on_signin(pid, token)`
- Summary: Device flow completed (GUI thread). Save the token to the key field.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_AiPanel__on_signin["UI signal"] --> H_ui_AiPanel__on_signin["_on_signin"]
  H_ui_AiPanel__on_signin --> R_ui_AiPanel__on_signin["QGIS/Runtime API"]
  R_ui_AiPanel__on_signin --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### ui.GeoDriverPlugin._on_toggle — _on_toggle

- kind: `ui_control` / source: `__init__.py:577`
- signature: `_on_toggle(checked)`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ui_GeoDriverPlugin__on_toggle["UI signal"] --> H_ui_GeoDriverPlugin__on_toggle["_on_toggle"]
  H_ui_GeoDriverPlugin__on_toggle --> R_ui_GeoDriverPlugin__on_toggle["QGIS/Runtime API"]
  R_ui_GeoDriverPlugin__on_toggle --> OUT["Result"]
```

- Verification: Standalone= / Integrated=operate via parent dialog, assert state
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### bridge.applyScaleWidth — applyScaleWidth

- kind: `bridge_method` / source: `bridge.py:316`
- signature: `applyScaleWidth(layer_id=…, category=…, scale=…, mode=…, profile=…, dry=…)`
- Summary: Apply standard line widths to the layer renderer.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_applyScaleWidth["AI/bridge_call"] --> H_bridge_applyScaleWidth["applyScaleWidth"]
  H_bridge_applyScaleWidth --> R_bridge_applyScaleWidth["QGIS/Runtime API"]
  R_bridge_applyScaleWidth --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call applyScaleWidth(dry=True) → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.deployMode — deployMode

- kind: `bridge_method` / source: `bridge.py:179`
- signature: `deployMode()`
- Summary: Return the deploy mode (dev/use) and each plugin's placement form (read-only).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_deployMode["AI/bridge_call"] --> H_bridge_deployMode["deployMode"]
  H_bridge_deployMode --> R_bridge_deployMode["QGIS/Runtime API"]
  R_bridge_deployMode --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call deployMode → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.hotReload — hotReload

- kind: `bridge_method` / source: `bridge.py:371`
- signature: `hotReload(plugin_ids=…)`
- Summary: Reload in-development plugins (default = all targets; driver last).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_hotReload["AI/bridge_call"] --> H_bridge_hotReload["hotReload"]
  H_bridge_hotReload --> R_bridge_hotReload["QGIS/Runtime API"]
  R_bridge_hotReload --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call hotReload → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.layerOrgProfiles — layerOrgProfiles

- kind: `bridge_method` / source: `bridge.py:198`
- signature: `layerOrgProfiles()`
- Summary: Return the available layer-organization profile list and the active one.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_layerOrgProfiles["AI/bridge_call"] --> H_bridge_layerOrgProfiles["layerOrgProfiles"]
  H_bridge_layerOrgProfiles --> R_bridge_layerOrgProfiles["QGIS/Runtime API"]
  R_bridge_layerOrgProfiles --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call layerOrgProfiles → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.layerOrgRules — layerOrgRules

- kind: `bridge_method` / source: `bridge.py:208`
- signature: `layerOrgRules(profile=…)`
- Summary: Return the profile's rule list (default = active).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_layerOrgRules["AI/bridge_call"] --> H_bridge_layerOrgRules["layerOrgRules"]
  H_bridge_layerOrgRules --> R_bridge_layerOrgRules["QGIS/Runtime API"]
  R_bridge_layerOrgRules --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call layerOrgRules → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.listDevPlugins — listDevPlugins

- kind: `bridge_method` / source: `bridge.py:361`
- signature: `listDevPlugins()`
- Summary: Return the hot-reload targets (plugin IDs placed in dev mode).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_listDevPlugins["AI/bridge_call"] --> H_bridge_listDevPlugins["listDevPlugins"]
  H_bridge_listDevPlugins --> R_bridge_listDevPlugins["QGIS/Runtime API"]
  R_bridge_listDevPlugins --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call listDevPlugins → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.openAiPanel — openAiPanel

- kind: `bridge_method` / source: `bridge.py:342`
- signature: `openAiPanel()`
- Summary: Open the AI assistant panel.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_openAiPanel["AI/bridge_call"] --> H_bridge_openAiPanel["openAiPanel"]
  H_bridge_openAiPanel --> R_bridge_openAiPanel["QGIS/Runtime API"]
  R_bridge_openAiPanel --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call openAiPanel → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.openConnInfo — openConnInfo

- kind: `bridge_method` / source: `bridge.py:350`
- signature: `openConnInfo()`
- Summary: Open the connection-info dialog.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_openConnInfo["AI/bridge_call"] --> H_bridge_openConnInfo["openConnInfo"]
  H_bridge_openConnInfo --> R_bridge_openConnInfo["QGIS/Runtime API"]
  R_bridge_openConnInfo --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call openConnInfo → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.openDeployMode — openDeployMode

- kind: `bridge_method` / source: `bridge.py:355`
- signature: `openDeployMode()`
- Summary: Open the Deploy Mode switch dialog (switching is a UI operation only).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_openDeployMode["AI/bridge_call"] --> H_bridge_openDeployMode["openDeployMode"]
  H_bridge_openDeployMode --> R_bridge_openDeployMode["QGIS/Runtime API"]
  R_bridge_openDeployMode --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call openDeployMode → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.organizeLayers — organizeLayers

- kind: `bridge_method` / source: `bridge.py:228`
- signature: `organizeLayers(profile=…, dry=…)`
- Summary: Re-place every layer in the project using the profile rules.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_organizeLayers["AI/bridge_call"] --> H_bridge_organizeLayers["organizeLayers"]
  H_bridge_organizeLayers --> R_bridge_organizeLayers["QGIS/Runtime API"]
  R_bridge_organizeLayers --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call organizeLayers → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.placeLayer — placeLayer

- kind: `bridge_method` / source: `bridge.py:240`
- signature: `placeLayer(layer_id=…, ctx=…)`
- Summary: Place a single layer into the organization rules.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_placeLayer["AI/bridge_call"] --> H_bridge_placeLayer["placeLayer"]
  H_bridge_placeLayer --> R_bridge_placeLayer["QGIS/Runtime API"]
  R_bridge_placeLayer --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call placeLayer → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.pluginInfo — pluginInfo

- kind: `bridge_method` / source: `bridge.py:50`
- signature: `pluginInfo()`
- Summary: Standard self-description for the describe_plugins catalog.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_pluginInfo["AI/bridge_call"] --> H_bridge_pluginInfo["pluginInfo"]
  H_bridge_pluginInfo --> R_bridge_pluginInfo["QGIS/Runtime API"]
  R_bridge_pluginInfo --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call pluginInfo → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.remoteControl — remoteControl

- kind: `bridge_method` / source: `bridge.py:389`
- signature: `remoteControl(enabled=…)`
- Summary: Get/set whether remote control is enabled.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_remoteControl["AI/bridge_call"] --> H_bridge_remoteControl["remoteControl"]
  H_bridge_remoteControl --> R_bridge_remoteControl["QGIS/Runtime API"]
  R_bridge_remoteControl --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call remoteControl → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.scaleStyleProfiles — scaleStyleProfiles

- kind: `bridge_method` / source: `bridge.py:266`
- signature: `scaleStyleProfiles()`
- Summary: Return the available standard line-width profiles and the active one.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_scaleStyleProfiles["AI/bridge_call"] --> H_bridge_scaleStyleProfiles["scaleStyleProfiles"]
  H_bridge_scaleStyleProfiles --> R_bridge_scaleStyleProfiles["QGIS/Runtime API"]
  R_bridge_scaleStyleProfiles --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call scaleStyleProfiles → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.scaleStyleTable — scaleStyleTable

- kind: `bridge_method` / source: `bridge.py:276`
- signature: `scaleStyleTable(profile=…)`
- Summary: Return the profile's per-scale-band / per-category line-width table.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_scaleStyleTable["AI/bridge_call"] --> H_bridge_scaleStyleTable["scaleStyleTable"]
  H_bridge_scaleStyleTable --> R_bridge_scaleStyleTable["QGIS/Runtime API"]
  R_bridge_scaleStyleTable --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call scaleStyleTable → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.setLayerOrgProfile — setLayerOrgProfile

- kind: `bridge_method` / source: `bridge.py:220`
- signature: `setLayerOrgProfile(name)`
- Summary: Switch the active organization profile (persisted in QSettings).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_setLayerOrgProfile["AI/bridge_call"] --> H_bridge_setLayerOrgProfile["setLayerOrgProfile"]
  H_bridge_setLayerOrgProfile --> R_bridge_setLayerOrgProfile["QGIS/Runtime API"]
  R_bridge_setLayerOrgProfile --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call setLayerOrgProfile → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.setScaleStyleProfile — setScaleStyleProfile

- kind: `bridge_method` / source: `bridge.py:288`
- signature: `setScaleStyleProfile(name)`
- Summary: Switch the active line-width profile (persisted in QSettings).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_setScaleStyleProfile["AI/bridge_call"] --> H_bridge_setScaleStyleProfile["setScaleStyleProfile"]
  H_bridge_setScaleStyleProfile --> R_bridge_setScaleStyleProfile["QGIS/Runtime API"]
  R_bridge_setScaleStyleProfile --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call setScaleStyleProfile → assert response
- Result: **skip** 2026-11-15T22:33:28+09:00 — manual verification target (side-effect / destructive / external-communication operation)

### bridge.status — status

- kind: `bridge_method` / source: `bridge.py:161`
- signature: `status()`
- Summary: Return the driver's running state.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_status["AI/bridge_call"] --> H_bridge_status["status"]
  H_bridge_status --> R_bridge_status["QGIS/Runtime API"]
  R_bridge_status --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call status → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### bridge.suggestScaleWidth — suggestScaleWidth

- kind: `bridge_method` / source: `bridge.py:296`
- signature: `suggestScaleWidth(layer_id=…, category=…, scale=…, profile=…)`
- Summary: Suggest a standard line width from the layer/category and scale.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_bridge_suggestScaleWidth["AI/bridge_call"] --> H_bridge_suggestScaleWidth["suggestScaleWidth"]
  H_bridge_suggestScaleWidth --> R_bridge_suggestScaleWidth["QGIS/Runtime API"]
  R_bridge_suggestScaleWidth --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call suggestScaleWidth → assert response
- Result: **pass** 2026-11-15T22:33:28+09:00 — bridge_call responded, args=[]

### registry.ai_client.py:register_extra_tools — register_extra_tools

- kind: `registry` / source: `ai_client.py:2503`
- signature: `register_extra_tools(tools, callers)`
- Summary: Reflect external MCP-derived tools into openai_tools/gemini_tools.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_registry_ai_client_py_register_extra_tools["Shared registry"] --> H_registry_ai_client_py_register_extra_tools["register_extra_tools"]
  H_registry_ai_client_py_register_extra_tools --> R_registry_ai_client_py_register_extra_tools["QGIS/Runtime API"]
  R_registry_ai_client_py_register_extra_tools --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### integration.__init__.py:59 — subprocess.run

- kind: `integration` / source: `__init__.py:59`
- signature: `subprocess.run(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration___init___py_59["Caller"] --> H_integration___init___py_59["subprocess.run"]
  H_integration___init___py_59 --> R_integration___init___py_59["QGIS/Runtime API"]
  R_integration___init___py_59 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2102 — HTTPServer

- kind: `integration` / source: `ai_client.py:2102`
- signature: `HTTPServer(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2102["Caller"] --> H_integration_ai_client_py_2102["HTTPServer"]
  H_integration_ai_client_py_2102 --> R_integration_ai_client_py_2102["QGIS/Runtime API"]
  R_integration_ai_client_py_2102 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2108 — HTTPServer

- kind: `integration` / source: `ai_client.py:2108`
- signature: `HTTPServer(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2108["Caller"] --> H_integration_ai_client_py_2108["HTTPServer"]
  H_integration_ai_client_py_2108 --> R_integration_ai_client_py_2108["QGIS/Runtime API"]
  R_integration_ai_client_py_2108 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2125 — webbrowser.open

- kind: `integration` / source: `ai_client.py:2125`
- signature: `webbrowser.open(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2125["Caller"] --> H_integration_ai_client_py_2125["webbrowser.open"]
  H_integration_ai_client_py_2125 --> R_integration_ai_client_py_2125["QGIS/Runtime API"]
  R_integration_ai_client_py_2125 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2144 — HTTPServer

- kind: `integration` / source: `ai_client.py:2144`
- signature: `HTTPServer(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2144["Caller"] --> H_integration_ai_client_py_2144["HTTPServer"]
  H_integration_ai_client_py_2144 --> R_integration_ai_client_py_2144["QGIS/Runtime API"]
  R_integration_ai_client_py_2144 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2150 — HTTPServer

- kind: `integration` / source: `ai_client.py:2150`
- signature: `HTTPServer(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2150["Caller"] --> H_integration_ai_client_py_2150["HTTPServer"]
  H_integration_ai_client_py_2150 --> R_integration_ai_client_py_2150["QGIS/Runtime API"]
  R_integration_ai_client_py_2150 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2167 — webbrowser.open

- kind: `integration` / source: `ai_client.py:2167`
- signature: `webbrowser.open(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2167["Caller"] --> H_integration_ai_client_py_2167["webbrowser.open"]
  H_integration_ai_client_py_2167 --> R_integration_ai_client_py_2167["QGIS/Runtime API"]
  R_integration_ai_client_py_2167 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2302 — subprocess.Popen

- kind: `integration` / source: `ai_client.py:2302`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2302["Caller"] --> H_integration_ai_client_py_2302["subprocess.Popen"]
  H_integration_ai_client_py_2302 --> R_integration_ai_client_py_2302["QGIS/Runtime API"]
  R_integration_ai_client_py_2302 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_client.py:2344 — subprocess.Popen

- kind: `integration` / source: `ai_client.py:2344`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_client_py_2344["Caller"] --> H_integration_ai_client_py_2344["subprocess.Popen"]
  H_integration_ai_client_py_2344 --> R_integration_ai_client_py_2344["QGIS/Runtime API"]
  R_integration_ai_client_py_2344 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_panel.py:2279 — QDesktopServices.openUrl

- kind: `integration` / source: `ai_panel.py:2279`
- signature: `QDesktopServices.openUrl(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_panel_py_2279["Caller"] --> H_integration_ai_panel_py_2279["QDesktopServices.openUrl"]
  H_integration_ai_panel_py_2279 --> R_integration_ai_panel_py_2279["QGIS/Runtime API"]
  R_integration_ai_panel_py_2279 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_panel.py:2293 — QDesktopServices.openUrl

- kind: `integration` / source: `ai_panel.py:2293`
- signature: `QDesktopServices.openUrl(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_panel_py_2293["Caller"] --> H_integration_ai_panel_py_2293["QDesktopServices.openUrl"]
  H_integration_ai_panel_py_2293 --> R_integration_ai_panel_py_2293["QGIS/Runtime API"]
  R_integration_ai_panel_py_2293 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_panel.py:492 — QDesktopServices.openUrl

- kind: `integration` / source: `ai_panel.py:492`
- signature: `QDesktopServices.openUrl(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_panel_py_492["Caller"] --> H_integration_ai_panel_py_492["QDesktopServices.openUrl"]
  H_integration_ai_panel_py_492 --> R_integration_ai_panel_py_492["QGIS/Runtime API"]
  R_integration_ai_panel_py_492 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.ai_panel.py:504 — QDesktopServices.openUrl

- kind: `integration` / source: `ai_panel.py:504`
- signature: `QDesktopServices.openUrl(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_ai_panel_py_504["Caller"] --> H_integration_ai_panel_py_504["QDesktopServices.openUrl"]
  H_integration_ai_panel_py_504 --> R_integration_ai_panel_py_504["QGIS/Runtime API"]
  R_integration_ai_panel_py_504 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.credential_store.py:153 — subprocess.run

- kind: `integration` / source: `credential_store.py:153`
- signature: `subprocess.run(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_credential_store_py_153["Caller"] --> H_integration_credential_store_py_153["subprocess.run"]
  H_integration_credential_store_py_153 --> R_integration_credential_store_py_153["QGIS/Runtime API"]
  R_integration_credential_store_py_153 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.credential_store.py:180 — subprocess.run

- kind: `integration` / source: `credential_store.py:180`
- signature: `subprocess.run(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_credential_store_py_180["Caller"] --> H_integration_credential_store_py_180["subprocess.run"]
  H_integration_credential_store_py_180 --> R_integration_credential_store_py_180["QGIS/Runtime API"]
  R_integration_credential_store_py_180 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.credential_store.py:68 — subprocess.run

- kind: `integration` / source: `credential_store.py:68`
- signature: `subprocess.run(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_credential_store_py_68["Caller"] --> H_integration_credential_store_py_68["subprocess.run"]
  H_integration_credential_store_py_68 --> R_integration_credential_store_py_68["QGIS/Runtime API"]
  R_integration_credential_store_py_68 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.devin_tasks.py:274 — subprocess.Popen

- kind: `integration` / source: `devin_tasks.py:274`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_devin_tasks_py_274["Caller"] --> H_integration_devin_tasks_py_274["subprocess.Popen"]
  H_integration_devin_tasks_py_274 --> R_integration_devin_tasks_py_274["QGIS/Runtime API"]
  R_integration_devin_tasks_py_274 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.devin_tasks.py:279 — subprocess.Popen

- kind: `integration` / source: `devin_tasks.py:279`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_devin_tasks_py_279["Caller"] --> H_integration_devin_tasks_py_279["subprocess.Popen"]
  H_integration_devin_tasks_py_279 --> R_integration_devin_tasks_py_279["QGIS/Runtime API"]
  R_integration_devin_tasks_py_279 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.devin_tasks.py:639 — subprocess.Popen

- kind: `integration` / source: `devin_tasks.py:639`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_devin_tasks_py_639["Caller"] --> H_integration_devin_tasks_py_639["subprocess.Popen"]
  H_integration_devin_tasks_py_639 --> R_integration_devin_tasks_py_639["QGIS/Runtime API"]
  R_integration_devin_tasks_py_639 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **removed** 2026-11-14T07:09:57+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.devin_tasks.py:647 — subprocess.Popen

- kind: `integration` / source: `devin_tasks.py:647`
- signature: `subprocess.Popen(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_devin_tasks_py_647["Caller"] --> H_integration_devin_tasks_py_647["subprocess.Popen"]
  H_integration_devin_tasks_py_647 --> R_integration_devin_tasks_py_647["QGIS/Runtime API"]
  R_integration_devin_tasks_py_647 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.mcp_http.py:664 — ThreadingHTTPServer

- kind: `integration` / source: `mcp_http.py:664`
- signature: `ThreadingHTTPServer(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_mcp_http_py_664["Caller"] --> H_integration_mcp_http_py_664["ThreadingHTTPServer"]
  H_integration_mcp_http_py_664 --> R_integration_mcp_http_py_664["QGIS/Runtime API"]
  R_integration_mcp_http_py_664 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### integration.mode_switch.py:225 — subprocess.run

- kind: `integration` / source: `mode_switch.py:225`
- signature: `subprocess.run(…)`
- Summary: External integration call
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_integration_mode_switch_py_225["Caller"] --> H_integration_mode_switch_py_225["subprocess.run"]
  H_integration_mode_switch_py_225 --> R_integration_mode_switch_py_225["QGIS/Runtime API"]
  R_integration_mode_switch_py_225 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=verify integration target existence / artifacts
- Result: **skip** 2026-11-15T22:33:28+09:00 — integration call site recorded (actual integration run verified via bridge_method, etc.)

### ai.bridge_route — Reached entirely via bridge_call

- kind: `ai_integration` / source: `bridge.py`
- signature: ``
- Summary: All bridge_methods callable via the AI route
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ai_bridge_route["AI route"] --> H_ai_bridge_route["Reached entirely via bridge_call"]
  H_ai_bridge_route --> R_ai_bridge_route["QGIS/Runtime API"]
  R_ai_bridge_route --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call all methods → record ok/error
- Result: **pass** 2026-11-15T22:33:28+09:00 — 10 methods reachable

### ai.catalog — Registered in describe_plugins

- kind: `ai_integration` / source: `via dsh_qgis_driver`
- signature: ``
- Summary: Listed in the catalog and callable
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ai_catalog["AI route"] --> H_ai_catalog["Registered in describe_plugins"]
  H_ai_catalog --> R_ai_catalog["QGIS/Runtime API"]
  R_ai_catalog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=describe_plugins → id exists in plugins[] + methods non-empty
- Result: **pass** 2026-11-15T22:33:28+09:00 — describe_plugins: methods=19

### ai.pluginInfo — pluginInfo self-description

- kind: `ai_integration` / source: `bridge.py`
- signature: `pluginInfo()`
- Summary: Accuracy of summary/when_to_use/methods
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_ai_pluginInfo["AI route"] --> H_ai_pluginInfo["pluginInfo self-description"]
  H_ai_pluginInfo --> R_ai_pluginInfo["QGIS/Runtime API"]
  R_ai_pluginInfo --> OUT["Result"]
```

- Verification: Standalone= / Integrated=bridge_call pluginInfo → assert metadata match
- Result: **pass** 2026-11-15T22:33:28+09:00 — self-description present

### logic_fn.ai_client.py:agents_dir — agents_dir

- kind: `logic_fn` / source: `ai_client.py:1443`
- signature: `agents_dir()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_agents_dir["Caller"] --> H_logic_fn_ai_client_py_agents_dir["agents_dir"]
  H_logic_fn_ai_client_py_agents_dir --> R_logic_fn_ai_client_py_agents_dir["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_agents_dir --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_content — anthropic_content

- kind: `logic_fn` / source: `ai_client.py:1190`
- signature: `anthropic_content(text, image_paths)`
- Summary: Turn a text + image-path list into Anthropic content.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_content["Caller"] --> H_logic_fn_ai_client_py_anthropic_content["anthropic_content"]
  H_logic_fn_ai_client_py_anthropic_content --> R_logic_fn_ai_client_py_anthropic_content["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_content --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_headers — anthropic_headers

- kind: `logic_fn` / source: `ai_client.py:1156`
- signature: `anthropic_headers(api_key)`
- Summary: Auth headers for the Messages API.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_headers["Caller"] --> H_logic_fn_ai_client_py_anthropic_headers["anthropic_headers"]
  H_logic_fn_ai_client_py_anthropic_headers --> R_logic_fn_ai_client_py_anthropic_headers["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_headers --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_image_part — anthropic_image_part

- kind: `logic_fn` / source: `ai_client.py:1179`
- signature: `anthropic_image_part(path)`
- Summary: PNG file → Anthropic image block (None if unreadable).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_image_part["Caller"] --> H_logic_fn_ai_client_py_anthropic_image_part["anthropic_image_part"]
  H_logic_fn_ai_client_py_anthropic_image_part --> R_logic_fn_ai_client_py_anthropic_image_part["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_image_part --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_messages — anthropic_messages

- kind: `logic_fn` / source: `ai_client.py:1203`
- signature: `anthropic_messages(base, api_key, model, system, messages, tools=…, timeout=…, extra=…)`
- Summary: POST {base}/v1/messages (non-streaming) and return the response JSON.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_messages["Caller"] --> H_logic_fn_ai_client_py_anthropic_messages["anthropic_messages"]
  H_logic_fn_ai_client_py_anthropic_messages --> R_logic_fn_ai_client_py_anthropic_messages["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_messages --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_messages_url — anthropic_messages_url

- kind: `logic_fn` / source: `ai_client.py:1146`
- signature: `anthropic_messages_url(base)`
- Summary: POST URL for messages.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_messages_url["Caller"] --> H_logic_fn_ai_client_py_anthropic_messages_url["anthropic_messages_url"]
  H_logic_fn_ai_client_py_anthropic_messages_url --> R_logic_fn_ai_client_py_anthropic_messages_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_messages_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_models_url — anthropic_models_url

- kind: `logic_fn` / source: `ai_client.py:1151`
- signature: `anthropic_models_url(base)`
- Summary: GET URL for the models list.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_models_url["Caller"] --> H_logic_fn_ai_client_py_anthropic_models_url["anthropic_models_url"]
  H_logic_fn_ai_client_py_anthropic_models_url --> R_logic_fn_ai_client_py_anthropic_models_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_models_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:anthropic_tools — anthropic_tools

- kind: `logic_fn` / source: `ai_client.py:1164`
- signature: `anthropic_tools(allowed=…)`
- Summary: mcp_http.TOOLS + INSTRUCTION_TOOLS + external MCP tools
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_anthropic_tools["Caller"] --> H_logic_fn_ai_client_py_anthropic_tools["anthropic_tools"]
  H_logic_fn_ai_client_py_anthropic_tools --> R_logic_fn_ai_client_py_anthropic_tools["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_anthropic_tools --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:attachment_temp_path — attachment_temp_path

- kind: `logic_fn` / source: `ai_client.py:1330`
- signature: `attachment_temp_path()`
- Summary: Save destination for images attached to chat input (normalize and write as PNG).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_attachment_temp_path["Caller"] --> H_logic_fn_ai_client_py_attachment_temp_path["attachment_temp_path"]
  H_logic_fn_ai_client_py_attachment_temp_path --> R_logic_fn_ai_client_py_attachment_temp_path["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_attachment_temp_path --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:azure_chat_url — azure_chat_url

- kind: `logic_fn` / source: `ai_client.py:1225`
- signature: `azure_chat_url(base)`
- Summary: Turn the Azure base (deployments path) into the chat/completions POST URL.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_azure_chat_url["Caller"] --> H_logic_fn_ai_client_py_azure_chat_url["azure_chat_url"]
  H_logic_fn_ai_client_py_azure_chat_url --> R_logic_fn_ai_client_py_azure_chat_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_azure_chat_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:azure_resource_url — azure_resource_url

- kind: `logic_fn` / source: `ai_client.py:1245`
- signature: `azure_resource_url(base, tail)`
- Summary: Build {scheme}://{host}/openai/<tail>?api-version=…
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_azure_resource_url["Caller"] --> H_logic_fn_ai_client_py_azure_resource_url["azure_resource_url"]
  H_logic_fn_ai_client_py_azure_resource_url --> R_logic_fn_ai_client_py_azure_resource_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_azure_resource_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:chat_completions — chat_completions

- kind: `logic_fn` / source: `ai_client.py:852`
- signature: `chat_completions(base, api_key, model, messages, tools=…, timeout=…, extra=…, headers=…)`
- Summary: POST {base}/chat/completions (non-streaming) and return the response JSON.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_chat_completions["Caller"] --> H_logic_fn_ai_client_py_chat_completions["chat_completions"]
  H_logic_fn_ai_client_py_chat_completions --> R_logic_fn_ai_client_py_chat_completions["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_chat_completions --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:classify_model — classify_model

- kind: `logic_fn` / source: `ai_client.py:387`
- signature: `classify_model(model_id, entry=…)`
- Summary: Infer the kind from the model ID (+ API metadata).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_classify_model["Caller"] --> H_logic_fn_ai_client_py_classify_model["classify_model"]
  H_logic_fn_ai_client_py_classify_model --> R_logic_fn_ai_client_py_classify_model["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_classify_model --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:close_acp_sessions — close_acp_sessions

- kind: `logic_fn` / source: `ai_client.py:2988`
- signature: `close_acp_sessions()`
- Summary: Close all sessions opened via devin_acp (on panel teardown).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_close_acp_sessions["Caller"] --> H_logic_fn_ai_client_py_close_acp_sessions["close_acp_sessions"]
  H_logic_fn_ai_client_py_close_acp_sessions --> R_logic_fn_ai_client_py_close_acp_sessions["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_close_acp_sessions --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:command_from_tool_call — command_from_tool_call

- kind: `logic_fn` / source: `ai_client.py:1304`
- signature: `command_from_tool_call(tc)`
- Summary: OpenAI tool_call object → (name, driver cmd).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_command_from_tool_call["Caller"] --> H_logic_fn_ai_client_py_command_from_tool_call["command_from_tool_call"]
  H_logic_fn_ai_client_py_command_from_tool_call --> R_logic_fn_ai_client_py_command_from_tool_call["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_command_from_tool_call --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:copilot_session — copilot_session

- kind: `logic_fn` / source: `ai_client.py:716`
- signature: `copilot_session(github_token, base)`
- Summary: Resolve a GitHub token into (Copilot API Bearer token, API base).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_copilot_session["Caller"] --> H_logic_fn_ai_client_py_copilot_session["copilot_session"]
  H_logic_fn_ai_client_py_copilot_session --> R_logic_fn_ai_client_py_copilot_session["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_copilot_session --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:delete_agent — delete_agent

- kind: `logic_fn` / source: `ai_client.py:1674`
- signature: `delete_agent(agent_id)`
- Summary: Delete the user-side agent file (bundled ones cannot be deleted).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_delete_agent["Caller"] --> H_logic_fn_ai_client_py_delete_agent["delete_agent"]
  H_logic_fn_ai_client_py_delete_agent --> R_logic_fn_ai_client_py_delete_agent["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_delete_agent --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:delete_instruction — delete_instruction

- kind: `logic_fn` / source: `ai_client.py:1684`
- signature: `delete_instruction(kind, item_id)`
- Summary: Delete the user-side <kind>/<id>.md (bundled ones cannot be deleted).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_delete_instruction["Caller"] --> H_logic_fn_ai_client_py_delete_instruction["delete_instruction"]
  H_logic_fn_ai_client_py_delete_instruction --> R_logic_fn_ai_client_py_delete_instruction["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_delete_instruction --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:delete_skill — delete_skill

- kind: `logic_fn` / source: `ai_client.py:1679`
- signature: `delete_skill(skill_id)`
- Summary: Delete the user-side skill file (bundled ones cannot be deleted).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_delete_skill["Caller"] --> H_logic_fn_ai_client_py_delete_skill["delete_skill"]
  H_logic_fn_ai_client_py_delete_skill --> R_logic_fn_ai_client_py_delete_skill["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_delete_skill --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:endpoint_url — endpoint_url

- kind: `logic_fn` / source: `ai_client.py:815`
- signature: `endpoint_url(base)`
- Summary: Normalize the base URL into the chat/completions POST target.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_endpoint_url["Caller"] --> H_logic_fn_ai_client_py_endpoint_url["endpoint_url"]
  H_logic_fn_ai_client_py_endpoint_url --> R_logic_fn_ai_client_py_endpoint_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_endpoint_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:fmt_tokens — fmt_tokens

- kind: `logic_fn` / source: `ai_client.py:429`
- signature: `fmt_tokens(n)`
- Summary: Abbreviate token counts (128000→"128k", 1048576→"1.0M").
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_fmt_tokens["Caller"] --> H_logic_fn_ai_client_py_fmt_tokens["fmt_tokens"]
  H_logic_fn_ai_client_py_fmt_tokens --> R_logic_fn_ai_client_py_fmt_tokens["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_fmt_tokens --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:gemini_generate — gemini_generate

- kind: `logic_fn` / source: `ai_client.py:1110`
- signature: `gemini_generate(base, api_key, model, system, contents, tools=…, timeout=…, extra=…)`
- Summary: POST {base}/models/{model}:generateContent and return the response JSON.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_gemini_generate["Caller"] --> H_logic_fn_ai_client_py_gemini_generate["gemini_generate"]
  H_logic_fn_ai_client_py_gemini_generate --> R_logic_fn_ai_client_py_gemini_generate["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_gemini_generate --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:gemini_models_url — gemini_models_url

- kind: `logic_fn` / source: `ai_client.py:1059`
- signature: `gemini_models_url(base)`
- Summary: Normalize the base URL into the models-list GET target.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_gemini_models_url["Caller"] --> H_logic_fn_ai_client_py_gemini_models_url["gemini_models_url"]
  H_logic_fn_ai_client_py_gemini_models_url --> R_logic_fn_ai_client_py_gemini_models_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_gemini_models_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:gemini_tools — gemini_tools

- kind: `logic_fn` / source: `ai_client.py:1085`
- signature: `gemini_tools(allowed=…)`
- Summary: mcp_http.TOOLS + INSTRUCTION_TOOLS + external MCP tools
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_gemini_tools["Caller"] --> H_logic_fn_ai_client_py_gemini_tools["gemini_tools"]
  H_logic_fn_ai_client_py_gemini_tools --> R_logic_fn_ai_client_py_gemini_tools["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_gemini_tools --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:gemini_url — gemini_url

- kind: `logic_fn` / source: `ai_client.py:1100`
- signature: `gemini_url(base, model)`
- Summary: POST URL for generateContent.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_gemini_url["Caller"] --> H_logic_fn_ai_client_py_gemini_url["gemini_url"]
  H_logic_fn_ai_client_py_gemini_url --> R_logic_fn_ai_client_py_gemini_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_gemini_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:get_provider — get_provider

- kind: `logic_fn` / source: `ai_client.py:3298`
- signature: `get_provider(provider)`
- Summary: Provider ID → provider instance.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_get_provider["Caller"] --> H_logic_fn_ai_client_py_get_provider["get_provider"]
  H_logic_fn_ai_client_py_get_provider --> R_logic_fn_ai_client_py_get_provider["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_get_provider --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:github_device_code — github_device_code

- kind: `logic_fn` / source: `ai_client.py:776`
- signature: `github_device_code(scope=…)`
- Summary: Start the OAuth device flow.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_github_device_code["Caller"] --> H_logic_fn_ai_client_py_github_device_code["github_device_code"]
  H_logic_fn_ai_client_py_github_device_code --> R_logic_fn_ai_client_py_github_device_code["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_github_device_code --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:github_poll_access_token — github_poll_access_token

- kind: `logic_fn` / source: `ai_client.py:790`
- signature: `github_poll_access_token(device_code)`
- Summary: Poll the device-flow token once.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_github_poll_access_token["Caller"] --> H_logic_fn_ai_client_py_github_poll_access_token["github_poll_access_token"]
  H_logic_fn_ai_client_py_github_poll_access_token --> R_logic_fn_ai_client_py_github_poll_access_token["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_github_poll_access_token --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:image_b64 — image_b64

- kind: `logic_fn` / source: `ai_client.py:1336`
- signature: `image_b64(path)`
- Summary: Turn a PNG file into a base64 string (None if unreadable).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_image_b64["Caller"] --> H_logic_fn_ai_client_py_image_b64["image_b64"]
  H_logic_fn_ai_client_py_image_b64 --> R_logic_fn_ai_client_py_image_b64["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_image_b64 --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:image_inline_part — image_inline_part

- kind: `logic_fn` / source: `ai_client.py:1354`
- signature: `image_inline_part(path)`
- Summary: PNG file → Gemini inlineData part (None if unreadable).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_image_inline_part["Caller"] --> H_logic_fn_ai_client_py_image_inline_part["image_inline_part"]
  H_logic_fn_ai_client_py_image_inline_part --> R_logic_fn_ai_client_py_image_inline_part["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_image_inline_part --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:image_message_content — image_message_content

- kind: `logic_fn` / source: `ai_client.py:1376`
- signature: `image_message_content(path, note=…)`
- Summary: Turn a PNG file into an OpenAI-vision content array (None if unreadable).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_image_message_content["Caller"] --> H_logic_fn_ai_client_py_image_message_content["image_message_content"]
  H_logic_fn_ai_client_py_image_message_content --> R_logic_fn_ai_client_py_image_message_content["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_image_message_content --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:image_url_part — image_url_part

- kind: `logic_fn` / source: `ai_client.py:1345`
- signature: `image_url_part(path)`
- Summary: PNG file → OpenAI image_url part (None if unreadable).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_image_url_part["Caller"] --> H_logic_fn_ai_client_py_image_url_part["image_url_part"]
  H_logic_fn_ai_client_py_image_url_part --> R_logic_fn_ai_client_py_image_url_part["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_image_url_part --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_agents — list_agents

- kind: `logic_fn` / source: `ai_client.py:1553`
- signature: `list_agents()`
- Summary: List of available agent instruction files.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_agents["Caller"] --> H_logic_fn_ai_client_py_list_agents["list_agents"]
  H_logic_fn_ai_client_py_list_agents --> R_logic_fn_ai_client_py_list_agents["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_agents --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_instruction_files — list_instruction_files

- kind: `logic_fn` / source: `ai_client.py:1528`
- signature: `list_instruction_files(kind)`
- Summary: Scan the .md files under "agents"|"skills".
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_instruction_files["Caller"] --> H_logic_fn_ai_client_py_list_instruction_files["list_instruction_files"]
  H_logic_fn_ai_client_py_list_instruction_files --> R_logic_fn_ai_client_py_list_instruction_files["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_instruction_files --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_model_infos — list_model_infos

- kind: `logic_fn` / source: `ai_client.py:3311`
- signature: `list_model_infos(provider, base, key, timeout=…)`
- Summary: Return the model list with metadata.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_model_infos["Caller"] --> H_logic_fn_ai_client_py_list_model_infos["list_model_infos"]
  H_logic_fn_ai_client_py_list_model_infos --> R_logic_fn_ai_client_py_list_model_infos["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_model_infos --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_models — list_models

- kind: `logic_fn` / source: `ai_client.py:3306`
- signature: `list_models(provider, base, key, timeout=…)`
- Summary: Return the available model IDs from the provider endpoint.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_models["Caller"] --> H_logic_fn_ai_client_py_list_models["list_models"]
  H_logic_fn_ai_client_py_list_models --> R_logic_fn_ai_client_py_list_models["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_models --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_prompts — list_prompts

- kind: `logic_fn` / source: `ai_client.py:1563`
- signature: `list_prompts()`
- Summary: Recommended prompts (canned text inserted into the chat input field).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_prompts["Caller"] --> H_logic_fn_ai_client_py_list_prompts["list_prompts"]
  H_logic_fn_ai_client_py_list_prompts --> R_logic_fn_ai_client_py_list_prompts["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_prompts --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:list_skills — list_skills

- kind: `logic_fn` / source: `ai_client.py:1558`
- signature: `list_skills()`
- Summary: List of available skill procedure files.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_list_skills["Caller"] --> H_logic_fn_ai_client_py_list_skills["list_skills"]
  H_logic_fn_ai_client_py_list_skills --> R_logic_fn_ai_client_py_list_skills["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_list_skills --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:load_agent — load_agent

- kind: `logic_fn` / source: `ai_client.py:1629`
- signature: `load_agent(agent_id)`
- Summary: Agent id → instruction text. None if unspecified / missing.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_load_agent["Caller"] --> H_logic_fn_ai_client_py_load_agent["load_agent"]
  H_logic_fn_ai_client_py_load_agent --> R_logic_fn_ai_client_py_load_agent["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_load_agent --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:load_instruction — load_instruction

- kind: `logic_fn` / source: `ai_client.py:1634`
- signature: `load_instruction(kind, item_id)`
- Summary: id of kind ("agents"|"skills") → body text. None if unspecified / missing.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_load_instruction["Caller"] --> H_logic_fn_ai_client_py_load_instruction["load_instruction"]
  H_logic_fn_ai_client_py_load_instruction --> R_logic_fn_ai_client_py_load_instruction["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_load_instruction --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:mcp_config_path — mcp_config_path

- kind: `logic_fn` / source: `ai_client.py:1844`
- signature: `mcp_config_path()`
- Summary: Settings file for external MCP servers.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_mcp_config_path["Caller"] --> H_logic_fn_ai_client_py_mcp_config_path["mcp_config_path"]
  H_logic_fn_ai_client_py_mcp_config_path --> R_logic_fn_ai_client_py_mcp_config_path["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_mcp_config_path --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:mcp_discover — mcp_discover

- kind: `logic_fn` / source: `ai_client.py:2462`
- signature: `mcp_discover(timeout=…, on_status=…, is_aborted=…)`
- Summary: Connect to every MCP server in the settings file and aggregate the tool list.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_mcp_discover["Caller"] --> H_logic_fn_ai_client_py_mcp_discover["mcp_discover"]
  H_logic_fn_ai_client_py_mcp_discover --> R_logic_fn_ai_client_py_mcp_discover["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_mcp_discover --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:mcp_save_config — mcp_save_config

- kind: `logic_fn` / source: `ai_client.py:1923`
- signature: `mcp_save_config(text)`
- Summary: Validate the settings JSON text and save it to mcp_servers.json.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_mcp_save_config["Caller"] --> H_logic_fn_ai_client_py_mcp_save_config["mcp_save_config"]
  H_logic_fn_ai_client_py_mcp_save_config --> R_logic_fn_ai_client_py_mcp_save_config["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_mcp_save_config --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:mcp_servers_config — mcp_servers_config

- kind: `logic_fn` / source: `ai_client.py:1907`
- signature: `mcp_servers_config()`
- Summary: Read mcp_servers.json and return {name: {command|url, ...}}.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_mcp_servers_config["Caller"] --> H_logic_fn_ai_client_py_mcp_servers_config["mcp_servers_config"]
  H_logic_fn_ai_client_py_mcp_servers_config --> R_logic_fn_ai_client_py_mcp_servers_config["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_mcp_servers_config --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:model_info — model_info

- kind: `logic_fn` / source: `ai_client.py:489`
- signature: `model_info(entry)`
- Summary: One element of list_model_entries() → {id, kind, price, price_desc,
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_model_info["Caller"] --> H_logic_fn_ai_client_py_model_info["model_info"]
  H_logic_fn_ai_client_py_model_info --> R_logic_fn_ai_client_py_model_info["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_model_info --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:model_label — model_label

- kind: `logic_fn` / source: `ai_client.py:547`
- signature: `model_label(info)`
- Summary: Display text for the combo. With a price, the 'id   $in/$out' form.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_model_label["Caller"] --> H_logic_fn_ai_client_py_model_label["model_label"]
  H_logic_fn_ai_client_py_model_label --> R_logic_fn_ai_client_py_model_label["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_model_label --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:model_tooltip — model_tooltip

- kind: `logic_fn` / source: `ai_client.py:553`
- signature: `model_tooltip(info)`
- Summary: Tooltip for the combo item (multi-line).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_model_tooltip["Caller"] --> H_logic_fn_ai_client_py_model_tooltip["model_tooltip"]
  H_logic_fn_ai_client_py_model_tooltip --> R_logic_fn_ai_client_py_model_tooltip["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_model_tooltip --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:openai_models_url — openai_models_url

- kind: `logic_fn` / source: `ai_client.py:805`
- signature: `openai_models_url(base)`
- Summary: Normalize the base URL into the models-list GET target.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_openai_models_url["Caller"] --> H_logic_fn_ai_client_py_openai_models_url["openai_models_url"]
  H_logic_fn_ai_client_py_openai_models_url --> R_logic_fn_ai_client_py_openai_models_url["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_openai_models_url --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:openai_msgs_to_responses_input — openai_msgs_to_responses_input

- kind: `logic_fn` / source: `ai_client.py:937`
- signature: `openai_msgs_to_responses_input(msgs)`
- Summary: OpenAI chat-format msgs → (instructions, Responses API input items).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_openai_msgs_to_responses_input["Caller"] --> H_logic_fn_ai_client_py_openai_msgs_to_responses_input["openai_msgs_to_responses_input"]
  H_logic_fn_ai_client_py_openai_msgs_to_responses_input --> R_logic_fn_ai_client_py_openai_msgs_to_responses_input["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_openai_msgs_to_responses_input --> OUT["Result"]
```

- Verification: Standalone=direct call, assert conversion result / Integrated=pyeval: attribute existence + conversion round-trip check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:openai_tools — openai_tools

- kind: `logic_fn` / source: `ai_client.py:834`
- signature: `openai_tools(allowed=…)`
- Summary: mcp_http.TOOLS + INSTRUCTION_TOOLS + external MCP tools
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_openai_tools["Caller"] --> H_logic_fn_ai_client_py_openai_tools["openai_tools"]
  H_logic_fn_ai_client_py_openai_tools --> R_logic_fn_ai_client_py_openai_tools["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_openai_tools --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:parse_responses_output — parse_responses_output

- kind: `logic_fn` / source: `ai_client.py:1005`
- signature: `parse_responses_output(data)`
- Summary: Responses API response → same {"text","calls","raw","usage"} as parse().
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_parse_responses_output["Caller"] --> H_logic_fn_ai_client_py_parse_responses_output["parse_responses_output"]
  H_logic_fn_ai_client_py_parse_responses_output --> R_logic_fn_ai_client_py_parse_responses_output["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_parse_responses_output --> OUT["Result"]
```

- Verification: Standalone=direct call, assert normalization result / Integrated=pyeval: attribute existence + normalization check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:parse_tool_arguments — parse_tool_arguments

- kind: `logic_fn` / source: `ai_client.py:1293`
- signature: `parse_tool_arguments(raw)`
- Summary: Turn tool_call arguments (JSON string) into a dict.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_parse_tool_arguments["Caller"] --> H_logic_fn_ai_client_py_parse_tool_arguments["parse_tool_arguments"]
  H_logic_fn_ai_client_py_parse_tool_arguments --> R_logic_fn_ai_client_py_parse_tool_arguments["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_parse_tool_arguments --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:parse_usage — parse_usage

- kind: `logic_fn` / source: `ai_client.py:519`
- signature: `parse_usage(data)`
- Summary: Normalize the API response usage into {"in","out"}|None.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_parse_usage["Caller"] --> H_logic_fn_ai_client_py_parse_usage["parse_usage"]
  H_logic_fn_ai_client_py_parse_usage --> R_logic_fn_ai_client_py_parse_usage["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_parse_usage --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:prompt_body — prompt_body

- kind: `logic_fn` / source: `ai_client.py:1608`
- signature: `prompt_body(item_id)`
- Summary: prompts id → body text inserted into the input field. None if unspecified / missing.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_prompt_body["Caller"] --> H_logic_fn_ai_client_py_prompt_body["prompt_body"]
  H_logic_fn_ai_client_py_prompt_body --> R_logic_fn_ai_client_py_prompt_body["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_prompt_body --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:prompts_dir — prompts_dir

- kind: `logic_fn` / source: `ai_client.py:1451`
- signature: `prompts_dir()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_prompts_dir["Caller"] --> H_logic_fn_ai_client_py_prompts_dir["prompts_dir"]
  H_logic_fn_ai_client_py_prompts_dir --> R_logic_fn_ai_client_py_prompts_dir["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_prompts_dir --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:provider_defaults — provider_defaults

- kind: `logic_fn` / source: `ai_client.py:626`
- signature: `provider_defaults(provider)`
- Summary: Provider ID → {"base","model","label","key_hint","endpoint_hint"}
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_provider_defaults["Caller"] --> H_logic_fn_ai_client_py_provider_defaults["provider_defaults"]
  H_logic_fn_ai_client_py_provider_defaults --> R_logic_fn_ai_client_py_provider_defaults["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_provider_defaults --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:reply_to_text — reply_to_text

- kind: `logic_fn` / source: `ai_client.py:1312`
- signature: `reply_to_text(rep)`
- Summary: Turn the driver reply dict into tool-result text.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_reply_to_text["Caller"] --> H_logic_fn_ai_client_py_reply_to_text["reply_to_text"]
  H_logic_fn_ai_client_py_reply_to_text --> R_logic_fn_ai_client_py_reply_to_text["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_reply_to_text --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:responses_create — responses_create

- kind: `logic_fn` / source: `ai_client.py:978`
- signature: `responses_create(base, api_key, model, msgs, tools=…, timeout=…, extra=…, headers=…)`
- Summary: POST {base}/responses (non-streaming) and return the response JSON.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_responses_create["Caller"] --> H_logic_fn_ai_client_py_responses_create["responses_create"]
  H_logic_fn_ai_client_py_responses_create --> R_logic_fn_ai_client_py_responses_create["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_responses_create --> OUT["Result"]
```

- Verification: Standalone=pytest (HTTP stub), assert POST response / Integrated=pyeval/bridge: import check inside QGIS
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:responses_tools — responses_tools

- kind: `logic_fn` / source: `ai_client.py:881`
- signature: `responses_tools(tools)`
- Summary: OpenAI function-calling form → Responses API tools form.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_responses_tools["Caller"] --> H_logic_fn_ai_client_py_responses_tools["responses_tools"]
  H_logic_fn_ai_client_py_responses_tools --> R_logic_fn_ai_client_py_responses_tools["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_responses_tools --> OUT["Result"]
```

- Verification: Standalone=pytest (HTTP stub) or direct call / Integrated=pyeval: attribute existence + conversion round-trip check
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:run_extra_tool — run_extra_tool

- kind: `logic_fn` / source: `ai_client.py:2513`
- signature: `run_extra_tool(name, args)`
- Summary: Execute an external MCP tool and return text.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_run_extra_tool["Caller"] --> H_logic_fn_ai_client_py_run_extra_tool["run_extra_tool"]
  H_logic_fn_ai_client_py_run_extra_tool --> R_logic_fn_ai_client_py_run_extra_tool["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_run_extra_tool --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:run_instruction_tool — run_instruction_tool

- kind: `logic_fn` / source: `ai_client.py:1787`
- signature: `run_instruction_tool(name, args)`
- Summary: Execute an ai_* tool and return the result text (panel-local execution).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_run_instruction_tool["Caller"] --> H_logic_fn_ai_client_py_run_instruction_tool["run_instruction_tool"]
  H_logic_fn_ai_client_py_run_instruction_tool --> R_logic_fn_ai_client_py_run_instruction_tool["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_run_instruction_tool --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:save_agent — save_agent

- kind: `logic_fn` / source: `ai_client.py:1648`
- signature: `save_agent(name, text)`
- Summary: Save as <name>.md under the user's agents/ and return the path.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_save_agent["Caller"] --> H_logic_fn_ai_client_py_save_agent["save_agent"]
  H_logic_fn_ai_client_py_save_agent --> R_logic_fn_ai_client_py_save_agent["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_save_agent --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:save_instruction — save_instruction

- kind: `logic_fn` / source: `ai_client.py:1658`
- signature: `save_instruction(kind, name, text)`
- Summary: Save as <name>.md under the user's <kind>/ and return the path.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_save_instruction["Caller"] --> H_logic_fn_ai_client_py_save_instruction["save_instruction"]
  H_logic_fn_ai_client_py_save_instruction --> R_logic_fn_ai_client_py_save_instruction["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_save_instruction --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:save_skill — save_skill

- kind: `logic_fn` / source: `ai_client.py:1653`
- signature: `save_skill(name, text)`
- Summary: Save as <name>.md under the user's skills/ and return the path.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_save_skill["Caller"] --> H_logic_fn_ai_client_py_save_skill["save_skill"]
  H_logic_fn_ai_client_py_save_skill --> R_logic_fn_ai_client_py_save_skill["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_save_skill --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:screenshot_temp_path — screenshot_temp_path

- kind: `logic_fn` / source: `ai_client.py:1325`
- signature: `screenshot_temp_path()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_screenshot_temp_path["Caller"] --> H_logic_fn_ai_client_py_screenshot_temp_path["screenshot_temp_path"]
  H_logic_fn_ai_client_py_screenshot_temp_path --> R_logic_fn_ai_client_py_screenshot_temp_path["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_screenshot_temp_path --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:skills_dir — skills_dir

- kind: `logic_fn` / source: `ai_client.py:1447`
- signature: `skills_dir()`
- Summary: 
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_skills_dir["Caller"] --> H_logic_fn_ai_client_py_skills_dir["skills_dir"]
  H_logic_fn_ai_client_py_skills_dir --> R_logic_fn_ai_client_py_skills_dir["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_skills_dir --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:system_prompt — system_prompt

- kind: `logic_fn` / source: `ai_client.py:1385`
- signature: `system_prompt(plugins=…, agent_text=…, skills=…, agents=…, active_agent=…)`
- Summary: Assemble the system prompt.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_system_prompt["Caller"] --> H_logic_fn_ai_client_py_system_prompt["system_prompt"]
  H_logic_fn_ai_client_py_system_prompt --> R_logic_fn_ai_client_py_system_prompt["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_system_prompt --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:tool_to_command — tool_to_command

- kind: `logic_fn` / source: `ai_client.py:1266`
- signature: `tool_to_command(name, args)`
- Summary: Convert a tool call (qgis_<type>) into the driver command dict.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_tool_to_command["Caller"] --> H_logic_fn_ai_client_py_tool_to_command["tool_to_command"]
  H_logic_fn_ai_client_py_tool_to_command --> R_logic_fn_ai_client_py_tool_to_command["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_tool_to_command --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:tr_label — tr_label

- kind: `logic_fn` / source: `ai_client.py:69`
- signature: `tr_label(src)`
- Summary: Runtime translation of UI display labels. Stays English where Qt is absent (pytest).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_tr_label["Caller"] --> H_logic_fn_ai_client_py_tr_label["tr_label"]
  H_logic_fn_ai_client_py_tr_label --> R_logic_fn_ai_client_py_tr_label["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_tr_label --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:trim_history — trim_history

- kind: `logic_fn` / source: `ai_client.py:1279`
- signature: `trim_history(history, max_chars=…)`
- Summary: Keep the chat history within max_chars. Drop from the oldest turns,
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_trim_history["Caller"] --> H_logic_fn_ai_client_py_trim_history["trim_history"]
  H_logic_fn_ai_client_py_trim_history --> R_logic_fn_ai_client_py_trim_history["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_trim_history --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:usage_cost — usage_cost

- kind: `logic_fn` / source: `ai_client.py:507`
- signature: `usage_cost(info, total)`
- Summary: model_info + cumulative usage {"in","out"} → estimated cost USD|None.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_usage_cost["Caller"] --> H_logic_fn_ai_client_py_usage_cost["usage_cost"]
  H_logic_fn_ai_client_py_usage_cost --> R_logic_fn_ai_client_py_usage_cost["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_usage_cost --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_client.py:user_content — user_content

- kind: `logic_fn` / source: `ai_client.py:1362`
- signature: `user_content(text, image_paths)`
- Summary: Turn user input (text + image-path list) into OpenAI content.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_client_py_user_content["Caller"] --> H_logic_fn_ai_client_py_user_content["user_content"]
  H_logic_fn_ai_client_py_user_content --> R_logic_fn_ai_client_py_user_content["QGIS/Runtime API"]
  R_logic_fn_ai_client_py_user_content --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.ai_panel.py:show_panel — show_panel

- kind: `logic_fn` / source: `ai_panel.py:2312`
- signature: `show_panel(iface, get_driver, panel)`
- Summary: Show the dock (creating it if needed) and return the instance.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_ai_panel_py_show_panel["Caller"] --> H_logic_fn_ai_panel_py_show_panel["show_panel"]
  H_logic_fn_ai_panel_py_show_panel --> R_logic_fn_ai_panel_py_show_panel["QGIS/Runtime API"]
  R_logic_fn_ai_panel_py_show_panel --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.connection_info.py:build_sections — build_sections

- kind: `logic_fn` / source: `connection_info.py:85`
- signature: `build_sections(plugin)`
- Summary: Assemble and return the per-tab display data.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_connection_info_py_build_sections["Caller"] --> H_logic_fn_connection_info_py_build_sections["build_sections"]
  H_logic_fn_connection_info_py_build_sections --> R_logic_fn_connection_info_py_build_sections["QGIS/Runtime API"]
  R_logic_fn_connection_info_py_build_sections --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.connection_info.py:show_dialog — show_dialog

- kind: `logic_fn` / source: `connection_info.py:143`
- signature: `show_dialog(plugin)`
- Summary: Open the connection-info dialog non-modally and return it.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_connection_info_py_show_dialog["Caller"] --> H_logic_fn_connection_info_py_show_dialog["show_dialog"]
  H_logic_fn_connection_info_py_show_dialog --> R_logic_fn_connection_info_py_show_dialog["QGIS/Runtime API"]
  R_logic_fn_connection_info_py_show_dialog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.credential_store.py:backend — backend

- kind: `logic_fn` / source: `credential_store.py:223`
- signature: `backend()`
- Summary: Return the backend ID in use.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_credential_store_py_backend["Caller"] --> H_logic_fn_credential_store_py_backend["backend"]
  H_logic_fn_credential_store_py_backend --> R_logic_fn_credential_store_py_backend["QGIS/Runtime API"]
  R_logic_fn_credential_store_py_backend --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.credential_store.py:backend_label — backend_label

- kind: `logic_fn` / source: `credential_store.py:234`
- signature: `backend_label()`
- Summary: Backend description for UI display.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_credential_store_py_backend_label["Caller"] --> H_logic_fn_credential_store_py_backend_label["backend_label"]
  H_logic_fn_credential_store_py_backend_label --> R_logic_fn_credential_store_py_backend_label["QGIS/Runtime API"]
  R_logic_fn_credential_store_py_backend_label --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.credential_store.py:delete_secret — delete_secret

- kind: `logic_fn` / source: `credential_store.py:279`
- signature: `delete_secret(name)`
- Summary: Delete the stored secret. Succeeds even if absent (idempotent).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_credential_store_py_delete_secret["Caller"] --> H_logic_fn_credential_store_py_delete_secret["delete_secret"]
  H_logic_fn_credential_store_py_delete_secret --> R_logic_fn_credential_store_py_delete_secret["QGIS/Runtime API"]
  R_logic_fn_credential_store_py_delete_secret --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.credential_store.py:get_secret — get_secret

- kind: `logic_fn` / source: `credential_store.py:264`
- signature: `get_secret(name)`
- Summary: Return the stored secret. None if absent.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_credential_store_py_get_secret["Caller"] --> H_logic_fn_credential_store_py_get_secret["get_secret"]
  H_logic_fn_credential_store_py_get_secret --> R_logic_fn_credential_store_py_get_secret["QGIS/Runtime API"]
  R_logic_fn_credential_store_py_get_secret --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.credential_store.py:set_secret — set_secret

- kind: `logic_fn` / source: `credential_store.py:247`
- signature: `set_secret(name, secret)`
- Summary: Store the secret. True on success.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_credential_store_py_set_secret["Caller"] --> H_logic_fn_credential_store_py_set_secret["set_secret"]
  H_logic_fn_credential_store_py_set_secret --> R_logic_fn_credential_store_py_set_secret["QGIS/Runtime API"]
  R_logic_fn_credential_store_py_set_secret --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.devin_tasks.py:abort — abort

- kind: `logic_fn` / source: `devin_tasks.py:369`
- signature: `abort(task_id)`
- Summary: Kill the running task.
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_devin_tasks_py_abort["Caller"] --> H_logic_fn_devin_tasks_py_abort["abort"]
  H_logic_fn_devin_tasks_py_abort --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.devin_tasks.py:find_exe — find_exe

- kind: `logic_fn` / source: `devin_tasks.py:49`
- signature: `find_exe(exe=…)`
- Summary: Resolve the path to devin.exe. None if not found.
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_devin_tasks_py_find_exe["Caller"] --> H_logic_fn_devin_tasks_py_find_exe["find_exe"]
  H_logic_fn_devin_tasks_py_find_exe --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.devin_tasks.py:result — result

- kind: `logic_fn` / source: `devin_tasks.py:359`
- signature: `result(task_id, tail=…)`
- Summary: Return the task output (log tail).
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_devin_tasks_py_result["Caller"] --> H_logic_fn_devin_tasks_py_result["result"]
  H_logic_fn_devin_tasks_py_result --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.devin_tasks.py:run — run

- kind: `logic_fn` / source: `devin_tasks.py:198`
- signature: `run(prompt, cwd=…, session_id=…, model=…, permission_mode=…, exe=…, live_dir=…, engine=…, agent=…)`
- Summary: Start an agent CLI session asynchronously and return task info.
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_devin_tasks_py_run["Caller"] --> H_logic_fn_devin_tasks_py_run["run"]
  H_logic_fn_devin_tasks_py_run --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.devin_tasks.py:status — status

- kind: `logic_fn` / source: `devin_tasks.py:346`
- signature: `status(task_id=…, tail=…)`
- Summary: Return the task status. All tasks listed when task_id is omitted.
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_devin_tasks_py_status["Caller"] --> H_logic_fn_devin_tasks_py_status["status"]
  H_logic_fn_devin_tasks_py_status --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.geo_toolbar.py:geo_suite_toolbar — geo_suite_toolbar

- kind: `logic_fn` / source: `geo_toolbar.py:16`
- signature: `geo_suite_toolbar(iface, ensure_visible=…)`
- Summary: Return the GeoSuite toolbar, creating it if absent.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_geo_toolbar_py_geo_suite_toolbar["Caller"] --> H_logic_fn_geo_toolbar_py_geo_suite_toolbar["geo_suite_toolbar"]
  H_logic_fn_geo_toolbar_py_geo_suite_toolbar --> R_logic_fn_geo_toolbar_py_geo_suite_toolbar["QGIS/Runtime API"]
  R_logic_fn_geo_toolbar_py_geo_suite_toolbar --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.hot_reload.py:dev_plugin_ids — dev_plugin_ids

- kind: `logic_fn` / source: `hot_reload.py:22`
- signature: `dev_plugin_ids(own_file)`
- Summary: Return the list of hot-reload candidate plugin IDs.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_hot_reload_py_dev_plugin_ids["Caller"] --> H_logic_fn_hot_reload_py_dev_plugin_ids["dev_plugin_ids"]
  H_logic_fn_hot_reload_py_dev_plugin_ids --> R_logic_fn_hot_reload_py_dev_plugin_ids["QGIS/Runtime API"]
  R_logic_fn_hot_reload_py_dev_plugin_ids --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.hot_reload.py:reload_plugins — reload_plugins

- kind: `logic_fn` / source: `hot_reload.py:47`
- signature: `reload_plugins(ids, notify=…)`
- Summary: Reload the plugin IDs in order.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_hot_reload_py_reload_plugins["Caller"] --> H_logic_fn_hot_reload_py_reload_plugins["reload_plugins"]
  H_logic_fn_hot_reload_py_reload_plugins --> R_logic_fn_hot_reload_py_reload_plugins["QGIS/Runtime API"]
  R_logic_fn_hot_reload_py_reload_plugins --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:layer_attrs — layer_attrs

- kind: `logic_fn` / source: `layer_org.py:132`
- signature: `layer_attrs(layer, ctx=…)`
- Summary: Build the attribute dict for rule matching from the layer + context.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_layer_attrs["Caller"] --> H_logic_fn_layer_org_py_layer_attrs["layer_attrs"]
  H_logic_fn_layer_org_py_layer_attrs --> R_logic_fn_layer_org_py_layer_attrs["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_layer_attrs --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:list_profiles — list_profiles

- kind: `logic_fn` / source: `layer_org.py:71`
- signature: `list_profiles()`
- Summary: Available profile list. [{id,name,description,builtin,path}].
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_list_profiles["Caller"] --> H_logic_fn_layer_org_py_list_profiles["list_profiles"]
  H_logic_fn_layer_org_py_list_profiles --> R_logic_fn_layer_org_py_list_profiles["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_list_profiles --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:load_profile — load_profile

- kind: `logic_fn` / source: `layer_org.py:99`
- signature: `load_profile(name)`
- Summary: Profile id → (dict, path). (None, None) if not found.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_load_profile["Caller"] --> H_logic_fn_layer_org_py_load_profile["load_profile"]
  H_logic_fn_layer_org_py_load_profile --> R_logic_fn_layer_org_py_load_profile["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_load_profile --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:match_rule — match_rule

- kind: `logic_fn` / source: `layer_org.py:183`
- signature: `match_rule(rules, attrs)`
- Summary: Evaluate the rule array from the top and return the first matching rule.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_match_rule["Caller"] --> H_logic_fn_layer_org_py_match_rule["match_rule"]
  H_logic_fn_layer_org_py_match_rule --> R_logic_fn_layer_org_py_match_rule["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_match_rule --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:profiles_dir — profiles_dir

- kind: `logic_fn` / source: `layer_org.py:56`
- signature: `profiles_dir()`
- Summary: User-defined profile location: ~/.qgis-live/layer_org/.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_profiles_dir["Caller"] --> H_logic_fn_layer_org_py_profiles_dir["profiles_dir"]
  H_logic_fn_layer_org_py_profiles_dir --> R_logic_fn_layer_org_py_profiles_dir["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_profiles_dir --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.layer_org.py:render_template — render_template

- kind: `logic_fn` / source: `layer_org.py:243`
- signature: `render_template(tpl, attrs)`
- Summary: Replace {token} in the rename template with attribute values.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_layer_org_py_render_template["Caller"] --> H_logic_fn_layer_org_py_render_template["render_template"]
  H_logic_fn_layer_org_py_render_template --> R_logic_fn_layer_org_py_render_template["QGIS/Runtime API"]
  R_logic_fn_layer_org_py_render_template --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.live_driver.py:reload_plugin_now — reload_plugin_now

- kind: `logic_fn` / source: `live_driver.py:91`
- signature: `reload_plugin_now(plugin_id)`
- Summary: Clear the sys.modules cache, reloadPlugin, and reopen open_dialog.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_live_driver_py_reload_plugin_now["Caller"] --> H_logic_fn_live_driver_py_reload_plugin_now["reload_plugin_now"]
  H_logic_fn_live_driver_py_reload_plugin_now --> R_logic_fn_live_driver_py_reload_plugin_now["QGIS/Runtime API"]
  R_logic_fn_live_driver_py_reload_plugin_now --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mcp_http.py:start_http — start_http

- kind: `logic_fn` / source: `mcp_http.py:657`
- signature: `start_http(driver, host=…, port=…, api_keys=…, allowed=…)`
- Summary: Start the HTTP server on a daemon thread and return the actual port.
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_mcp_http_py_start_http["Caller"] --> H_logic_fn_mcp_http_py_start_http["start_http"]
  H_logic_fn_mcp_http_py_start_http --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.mcp_stdio.py:main — main

- kind: `logic_fn` / source: `mcp_stdio.py:347`
- signature: `main()`
- Summary: 
- needs_runtime=False / standalone_ok=True

```mermaid
flowchart LR
  E_logic_fn_mcp_stdio_py_main["Caller"] --> H_logic_fn_mcp_stdio_py_main["main"]
  H_logic_fn_mcp_stdio_py_main --> OUT["Result"]
```

- Verification: Standalone=import→call→assert return value / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — standalone import + attr existence

### logic_fn.mode_switch.py:deploy_state — deploy_state

- kind: `logic_fn` / source: `mode_switch.py:149`
- signature: `deploy_state(own_file)`
- Summary: Return the current deploy state.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_deploy_state["Caller"] --> H_logic_fn_mode_switch_py_deploy_state["deploy_state"]
  H_logic_fn_mode_switch_py_deploy_state --> R_logic_fn_mode_switch_py_deploy_state["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_deploy_state --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:managed_ids — managed_ids

- kind: `logic_fn` / source: `mode_switch.py:127`
- signature: `managed_ids(own_file)`
- Summary: Managed plugin ID list. repo-side plugin.config.json takes priority,
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_managed_ids["Caller"] --> H_logic_fn_mode_switch_py_managed_ids["managed_ids"]
  H_logic_fn_mode_switch_py_managed_ids --> R_logic_fn_mode_switch_py_managed_ids["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_managed_ids --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:profile_root — profile_root

- kind: `logic_fn` / source: `mode_switch.py:75`
- signature: `profile_root(own_file)`
- Summary: From the deploy target .../<profile>/python/plugins/<id>/<file>
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_profile_root["Caller"] --> H_logic_fn_mode_switch_py_profile_root["profile_root"]
  H_logic_fn_mode_switch_py_profile_root --> R_logic_fn_mode_switch_py_profile_root["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_profile_root --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:read_marker — read_marker

- kind: `logic_fn` / source: `mode_switch.py:95`
- signature: `read_marker(own_file)`
- Summary: Read the mode-declaration marker. Empty dict if absent.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_read_marker["Caller"] --> H_logic_fn_mode_switch_py_read_marker["read_marker"]
  H_logic_fn_mode_switch_py_read_marker --> R_logic_fn_mode_switch_py_read_marker["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_read_marker --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:repo_root — repo_root

- kind: `logic_fn` / source: `mode_switch.py:108`
- signature: `repo_root(own_file)`
- Summary: Return the harness repository root.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_repo_root["Caller"] --> H_logic_fn_mode_switch_py_repo_root["repo_root"]
  H_logic_fn_mode_switch_py_repo_root --> R_logic_fn_mode_switch_py_repo_root["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_repo_root --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:set_repo_path — set_repo_path

- kind: `logic_fn` / source: `mode_switch.py:54`
- signature: `set_repo_path(path)`
- Summary: Save the harness repo path to QSettings. None/empty clears it.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_set_repo_path["Caller"] --> H_logic_fn_mode_switch_py_set_repo_path["set_repo_path"]
  H_logic_fn_mode_switch_py_set_repo_path --> R_logic_fn_mode_switch_py_set_repo_path["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_set_repo_path --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:show_dialog — show_dialog

- kind: `logic_fn` / source: `mode_switch.py:232`
- signature: `show_dialog(iface, own_file, notify=…)`
- Summary: Show the mode-switch dialog modally.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_show_dialog["Caller"] --> H_logic_fn_mode_switch_py_show_dialog["show_dialog"]
  H_logic_fn_mode_switch_py_show_dialog --> R_logic_fn_mode_switch_py_show_dialog["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_show_dialog --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.mode_switch.py:switch_mode — switch_mode

- kind: `logic_fn` / source: `mode_switch.py:198`
- signature: `switch_mode(own_file, mode)`
- Summary: Run deploy-plugin.ps1 to switch modes. Return (ok, output).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_mode_switch_py_switch_mode["Caller"] --> H_logic_fn_mode_switch_py_switch_mode["switch_mode"]
  H_logic_fn_mode_switch_py_switch_mode --> R_logic_fn_mode_switch_py_switch_mode["QGIS/Runtime API"]
  R_logic_fn_mode_switch_py_switch_mode --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:band_for_scale — band_for_scale

- kind: `logic_fn` / source: `scale_style.py:110`
- signature: `band_for_scale(prof, scale)`
- Summary: Return the scale_bands entry for the scale denominator (first match wins).
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_band_for_scale["Caller"] --> H_logic_fn_scale_style_py_band_for_scale["band_for_scale"]
  H_logic_fn_scale_style_py_band_for_scale --> R_logic_fn_scale_style_py_band_for_scale["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_band_for_scale --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:list_profiles — list_profiles

- kind: `logic_fn` / source: `scale_style.py:66`
- signature: `list_profiles()`
- Summary: Available profile list. [{id,name,description,builtin,path}].
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_list_profiles["Caller"] --> H_logic_fn_scale_style_py_list_profiles["list_profiles"]
  H_logic_fn_scale_style_py_list_profiles --> R_logic_fn_scale_style_py_list_profiles["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_list_profiles --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:load_profile — load_profile

- kind: `logic_fn` / source: `scale_style.py:94`
- signature: `load_profile(name)`
- Summary: Profile id → (dict, path). (None, None) if not found.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_load_profile["Caller"] --> H_logic_fn_scale_style_py_load_profile["load_profile"]
  H_logic_fn_scale_style_py_load_profile --> R_logic_fn_scale_style_py_load_profile["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_load_profile --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:match_category — match_category

- kind: `logic_fn` / source: `scale_style.py:135`
- signature: `match_category(prof, attrs)`
- Summary: Evaluate categories from the top and return the first matching category.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_match_category["Caller"] --> H_logic_fn_scale_style_py_match_category["match_category"]
  H_logic_fn_scale_style_py_match_category --> R_logic_fn_scale_style_py_match_category["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_match_category --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:mm_to_meters — mm_to_meters

- kind: `logic_fn` / source: `scale_style.py:143`
- signature: `mm_to_meters(width_mm, scale)`
- Summary: Paper mm → real feature width m (scale = scale denominator). None if the scale is unknown.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_mm_to_meters["Caller"] --> H_logic_fn_scale_style_py_mm_to_meters["mm_to_meters"]
  H_logic_fn_scale_style_py_mm_to_meters --> R_logic_fn_scale_style_py_mm_to_meters["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_mm_to_meters --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:profiles_dir — profiles_dir

- kind: `logic_fn` / source: `scale_style.py:55`
- signature: `profiles_dir()`
- Summary: User-defined profile location: ~/.qgis-live/scale_style/.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_profiles_dir["Caller"] --> H_logic_fn_scale_style_py_profiles_dir["profiles_dir"]
  H_logic_fn_scale_style_py_profiles_dir --> R_logic_fn_scale_style_py_profiles_dir["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_profiles_dir --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:renderer_symbols — renderer_symbols

- kind: `logic_fn` / source: `scale_style.py:204`
- signature: `renderer_symbols(renderer)`
- Summary: Enumerate all symbols held by the renderer.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_renderer_symbols["Caller"] --> H_logic_fn_scale_style_py_renderer_symbols["renderer_symbols"]
  H_logic_fn_scale_style_py_renderer_symbols --> R_logic_fn_scale_style_py_renderer_symbols["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_renderer_symbols --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

### logic_fn.scale_style.py:suggested_mm — suggested_mm

- kind: `logic_fn` / source: `scale_style.py:151`
- signature: `suggested_mm(prof, cat, scale)`
- Summary: Return the recommended mm width: the category base_mm multiplied by the scale-band factor.
- needs_runtime=True / standalone_ok=False

```mermaid
flowchart LR
  E_logic_fn_scale_style_py_suggested_mm["Caller"] --> H_logic_fn_scale_style_py_suggested_mm["suggested_mm"]
  H_logic_fn_scale_style_py_suggested_mm --> R_logic_fn_scale_style_py_suggested_mm["QGIS/Runtime API"]
  R_logic_fn_scale_style_py_suggested_mm --> OUT["Result"]
```

- Verification: Standalone= / Integrated=pyeval: attribute existence + call if needed
- Result: **pass** 2026-11-15T22:33:28+09:00 — attribute/symbol existence check (pyeval)

## Verification matrix

| Feature | kind | Standalone | Integrated | Result |
|---|---|---|---|---|
| entry_point.__init__.py:classFactory | entry_point | - | ○ | pass |
| action.GeoDriverPlugin.initGui | action | - | ○ | pass |
| action.GeoDriverPlugin.unload | action | - | ○ | pass |
| action._GenericBridge.openDialog | action | - | ○ | pass |
| action._GenericBridge.run | action | - | ○ | pass |
| dialog.AiPanel | dialog | - | ○ | pass |
| dialog._InstructionsDialog | dialog | - | ○ | pass |
| dialog._McpDialog | dialog | - | ○ | pass |
| ui.AiPanel._on_agent_activated | ui_control | - | ○ | pass |
| ui.AiPanel._on_agent_changed | ui_control | - | ○ | pass |
| ui.AiPanel._on_confirm | ui_control | - | ○ | pass |
| ui.AiPanel._on_destroyed | ui_control | - | ○ | pass |
| ui.AiPanel._on_model_activated | ui_control | - | ○ | pass |
| ui.AiPanel._on_model_text_changed | ui_control | - | ○ | pass |
| ui.AiPanel._on_models | ui_control | - | ○ | pass |
| ui.AiPanel._on_pasted_images | ui_control | - | ○ | pass |
| ui.AiPanel._on_prompt_activated | ui_control | - | ○ | pass |
| ui.AiPanel._on_provider_changed | ui_control | - | ○ | pass |
| ui.AiPanel._on_settings_toggled | ui_control | - | ○ | pass |
| ui.AiPanel._on_signin | ui_control | - | ○ | pass |
| ui.GeoDriverPlugin._on_toggle | ui_control | - | ○ | pass |
| bridge.applyScaleWidth | bridge_method | - | ○ | skip |
| bridge.deployMode | bridge_method | - | ○ | skip |
| bridge.hotReload | bridge_method | - | ○ | skip |
| bridge.layerOrgProfiles | bridge_method | - | ○ | pass |
| bridge.layerOrgRules | bridge_method | - | ○ | pass |
| bridge.listDevPlugins | bridge_method | - | ○ | pass |
| bridge.openAiPanel | bridge_method | - | ○ | skip |
| bridge.openConnInfo | bridge_method | - | ○ | skip |
| bridge.openDeployMode | bridge_method | - | ○ | skip |
| bridge.organizeLayers | bridge_method | - | ○ | pass |
| bridge.placeLayer | bridge_method | - | ○ | pass |
| bridge.pluginInfo | bridge_method | - | ○ | pass |
| bridge.remoteControl | bridge_method | - | ○ | skip |
| bridge.scaleStyleProfiles | bridge_method | - | ○ | pass |
| bridge.scaleStyleTable | bridge_method | - | ○ | pass |
| bridge.setLayerOrgProfile | bridge_method | - | ○ | skip |
| bridge.setScaleStyleProfile | bridge_method | - | ○ | skip |
| bridge.status | bridge_method | - | ○ | pass |
| bridge.suggestScaleWidth | bridge_method | - | ○ | pass |
| registry.ai_client.py:register_extra_tools | registry | - | ○ | pass |
| integration.__init__.py:59 | integration | - | ○ | skip |
| integration.ai_client.py:2102 | integration | - | ○ | removed |
| integration.ai_client.py:2108 | integration | - | ○ | removed |
| integration.ai_client.py:2125 | integration | - | ○ | removed |
| integration.ai_client.py:2144 | integration | - | ○ | skip |
| integration.ai_client.py:2150 | integration | - | ○ | skip |
| integration.ai_client.py:2167 | integration | - | ○ | skip |
| integration.ai_client.py:2302 | integration | - | ○ | removed |
| integration.ai_client.py:2344 | integration | - | ○ | skip |
| integration.ai_panel.py:2279 | integration | - | ○ | removed |
| integration.ai_panel.py:2293 | integration | - | ○ | skip |
| integration.ai_panel.py:492 | integration | - | ○ | removed |
| integration.ai_panel.py:504 | integration | - | ○ | skip |
| integration.credential_store.py:153 | integration | - | ○ | skip |
| integration.credential_store.py:180 | integration | - | ○ | skip |
| integration.credential_store.py:68 | integration | - | ○ | skip |
| integration.devin_tasks.py:274 | integration | - | ○ | skip |
| integration.devin_tasks.py:279 | integration | - | ○ | skip |
| integration.devin_tasks.py:639 | integration | - | ○ | removed |
| integration.devin_tasks.py:647 | integration | - | ○ | skip |
| integration.mcp_http.py:664 | integration | - | ○ | skip |
| integration.mode_switch.py:225 | integration | - | ○ | skip |
| ai.bridge_route | ai_integration | - | ○ | pass |
| ai.catalog | ai_integration | - | ○ | pass |
| ai.pluginInfo | ai_integration | - | ○ | pass |
| logic_fn.ai_client.py:agents_dir | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_content | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_headers | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_image_part | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_messages | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_messages_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_models_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:anthropic_tools | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:attachment_temp_path | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:azure_chat_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:azure_resource_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:chat_completions | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:classify_model | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:close_acp_sessions | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:command_from_tool_call | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:copilot_session | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:delete_agent | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:delete_instruction | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:delete_skill | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:endpoint_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:fmt_tokens | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:gemini_generate | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:gemini_models_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:gemini_tools | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:gemini_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:get_provider | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:github_device_code | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:github_poll_access_token | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:image_b64 | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:image_inline_part | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:image_message_content | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:image_url_part | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_agents | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_instruction_files | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_model_infos | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_models | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_prompts | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:list_skills | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:load_agent | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:load_instruction | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:mcp_config_path | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:mcp_discover | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:mcp_save_config | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:mcp_servers_config | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:model_info | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:model_label | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:model_tooltip | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:openai_models_url | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:openai_msgs_to_responses_input | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:openai_tools | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:parse_responses_output | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:parse_tool_arguments | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:parse_usage | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:prompt_body | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:prompts_dir | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:provider_defaults | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:reply_to_text | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:responses_create | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:responses_tools | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:run_extra_tool | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:run_instruction_tool | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:save_agent | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:save_instruction | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:save_skill | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:screenshot_temp_path | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:skills_dir | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:system_prompt | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:tool_to_command | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:tr_label | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:trim_history | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:usage_cost | logic_fn | - | ○ | pass |
| logic_fn.ai_client.py:user_content | logic_fn | - | ○ | pass |
| logic_fn.ai_panel.py:show_panel | logic_fn | - | ○ | pass |
| logic_fn.connection_info.py:build_sections | logic_fn | - | ○ | pass |
| logic_fn.connection_info.py:show_dialog | logic_fn | - | ○ | pass |
| logic_fn.credential_store.py:backend | logic_fn | - | ○ | pass |
| logic_fn.credential_store.py:backend_label | logic_fn | - | ○ | pass |
| logic_fn.credential_store.py:delete_secret | logic_fn | - | ○ | pass |
| logic_fn.credential_store.py:get_secret | logic_fn | - | ○ | pass |
| logic_fn.credential_store.py:set_secret | logic_fn | - | ○ | pass |
| logic_fn.devin_tasks.py:abort | logic_fn | ○ | - | pass |
| logic_fn.devin_tasks.py:find_exe | logic_fn | ○ | - | pass |
| logic_fn.devin_tasks.py:result | logic_fn | ○ | - | pass |
| logic_fn.devin_tasks.py:run | logic_fn | ○ | - | pass |
| logic_fn.devin_tasks.py:status | logic_fn | ○ | - | pass |
| logic_fn.geo_toolbar.py:geo_suite_toolbar | logic_fn | - | ○ | pass |
| logic_fn.hot_reload.py:dev_plugin_ids | logic_fn | - | ○ | pass |
| logic_fn.hot_reload.py:reload_plugins | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:layer_attrs | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:list_profiles | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:load_profile | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:match_rule | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:profiles_dir | logic_fn | - | ○ | pass |
| logic_fn.layer_org.py:render_template | logic_fn | - | ○ | pass |
| logic_fn.live_driver.py:reload_plugin_now | logic_fn | - | ○ | pass |
| logic_fn.mcp_http.py:start_http | logic_fn | ○ | - | pass |
| logic_fn.mcp_stdio.py:main | logic_fn | ○ | - | pass |
| logic_fn.mode_switch.py:deploy_state | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:managed_ids | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:profile_root | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:read_marker | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:repo_root | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:set_repo_path | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:show_dialog | logic_fn | - | ○ | pass |
| logic_fn.mode_switch.py:switch_mode | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:band_for_scale | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:list_profiles | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:load_profile | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:match_category | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:mm_to_meters | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:profiles_dir | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:renderer_symbols | logic_fn | - | ○ | pass |
| logic_fn.scale_style.py:suggested_mm | logic_fn | - | ○ | pass |