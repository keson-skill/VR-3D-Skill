# AI VR室内设计系统方案设计思路

## 1. 项目定位

目标：

构建一个基于多模态空间推理模型 + 图像生成模型 + 3D生成模型 + WebVR 的 AI 室内设计系统。

用户输入：

-   CAD户型图
-   平面设计图
-   室内照片
-   装修需求描述

系统自动生成：

-   三维室内空间
-   家具布置
-   材质灯光方案
-   AI效果图与风格预演
-   VR漫游体验
-   AI装修修改能力

核心理念：

> 不做单纯的3D模型生成，而是打造一个具备空间理解能力的AI建筑设计师。

------------------------------------------------------------------------

# 2. 总体技术架构

    CAD / 图片 / 用户需求
              |
              ↓
 RealmRouter OpenAI Compatible Gateway
              |
              ↓
   GPT-5.6 Sol多模态空间理解
              |
              ↓
     Spatial JSON 空间语义模型
              |
              ↓
       空间与设计约束验证
              |
       ----------------------
       |                    |
       ↓                    ↓
 GPT Image 2视觉预演    Kimi K3 Agent工程生成
       |                    |
       ↓              -----------------
  效果图/风格对比       |               |
                       ↓               ↓
                 Three.js/WebGPU   Blender Pipeline
                       |               |
                       ↓               ↓
                    WebVR场景       高质量3D场景

              +

     混元3D / Hunyuan3D
              |
              ↓
     家具与装饰资产生成

------------------------------------------------------------------------

# 3. 模块设计

## 3.0 OpenAI兼容网关层（RealmRouter）

定位：

RealmRouter作为GPT-5.6 Sol与GPT Image 2的OpenAI兼容接入层，负责统一鉴权和路由，不拥有空间事实、设计约束或业务状态。

配置：

``` dotenv
REALMROUTER_BASE_URL=https://realmrouter.cn
REALMROUTER_SPATIAL_API_KEY=
REALMROUTER_IMAGE_API_KEY=
REALMROUTER_SPATIAL_MODEL=gpt-5.6-sol
REALMROUTER_IMAGE_MODEL=gpt-image-2
```

安全要求：

-   真实密钥只存放在被Git忽略的`.env`中。
-   客户户型图、室内照片和地址在发送前必须获得第三方供应商授权。
-   日志仅记录模型ID、请求ID、延迟、错误码和验证结果，不记录鉴权头或完整客户输入。
-   已粘贴到聊天、日志、截图或Issue中的密钥必须撤销并重新生成。

能力验证：

1. RealmRouter当前没有通用的`gpt-5.6`模型ID，空间推理默认使用`gpt-5.6-sol`。
2. `gpt-5.6-sol`当前通过`POST /v1/chat/completions`提供，支持`GPT-plus`、`GPT-plus 特惠`、`GPT-pro`或`default`分组。
3. `gpt-image-2`当前通过`POST /v1/images/generations`提供，只支持`GPT-image`分组。
4. 每个RealmRouter令牌绑定一个分组，因此空间推理和图像生成使用两把独立的最小权限令牌。
5. 分别通过模型目录检查两把令牌是否可见目标模型，再执行最小Chat Completions与Images Generations请求验证实际路由权限。
6. 模型目录可见不等于调用一定成功，仍需同时满足令牌分组、余额、通道和接口权限。

------------------------------------------------------------------------

## 3.1 空间理解层（GPT-5.6 Sol）

职责：

-   识别CAD结构
-   理解房间布局
-   分析空间关系
-   判断设计风格
-   生成空间语义描述

输出：

``` json
{
 "rooms":[
  {
   "type":"living_room",
   "size":"5.5m x 4m",
   "position":[0,0]
  }
 ],
 "style":"modern luxury"
}
```

核心能力：

-   墙体识别
-   门窗识别
-   房间分类
-   动线分析
-   人体尺度理解

------------------------------------------------------------------------

## 3.2 视觉方案预演层（GPT Image 2）

定位：

GPT Image 2不替代GPT-5.6 Sol的空间理解与设计推理，而是在Spatial JSON和设计约束通过验证后，生成用于沟通、比较和人工审阅的二维视觉方案。

事件：

    design.approved
          |
          ↓
    visualization.generate.requested
          |
          ↓
    visualization.generated

输入：

-   已批准的Spatial JSON
-   室内原始照片或户型图
-   已锁定的墙体、门窗、家具位置与动线约束
-   风格、材质、色彩、灯光和镜头要求

职责：

-   生成室内概念效果图
-   生成奶油风、胡桃木风等风格对比图
-   进行材质、色彩和灯光预演
-   对室内照片执行局部改图和方案迭代
-   为客户确认和设计师评审提供视觉检查材料

输出：

-   PNG、JPEG或WebP效果图
-   方案版本ID
-   使用的设计修订版本
-   生成提示与请求ID

调用方式：

-   需要明确使用`gpt-image-2`时，通过RealmRouter OpenAI Compatible的`POST /v1/images/generations`生成效果图。
-   图像编辑使用`POST /v1/images/edits`并以`multipart/form-data`上传原图和可选蒙版。
-   多轮对话式改图只有在网关确认完整兼容Responses图像工具后才启用；空间推理仍由GPT-5.6 Sol完成。

边界：

-   效果图不是空间数据源，也不是施工或放样依据。
-   不允许从效果图反向覆盖已批准的墙体、门窗、尺寸、家具Transform和动线。
-   不负责输出Spatial JSON、判断结构安全、计算净空或执行碰撞验证。
-   当效果图与Spatial JSON不一致时，以Spatial JSON和几何验证结果为准。

参考：

-   [OpenAI Image generation](https://developers.openai.com/api/docs/guides/image-generation)
-   [OpenAI Grounded Spatial Reasoning](https://developers.openai.com/cookbook/examples/multimodal/grounded_spatial_reasoning_layouts)
-   [RealmRouter OpenAI Compatible](https://docs.realmrouter.cn/api/openai-compatible)
-   [RealmRouter Images示例](https://docs.realmrouter.cn/examples/images)

------------------------------------------------------------------------

# 4. AI Agent工程层（Kimi K3）

职责：

将空间设计转换成可运行3D工程。

生成：

-   Three.js代码
-   Blender Python脚本
-   场景配置文件
-   交互逻辑

例如：

    scene.js
    wall.js
    camera.js
    lighting.js
    interaction.js
    assets.json

负责：

-   创建3D空间
-   添加灯光
-   设置摄像机
-   实现VR交互

------------------------------------------------------------------------

# 5. 3D资产生成层（混元3D）

职责：

生成高质量室内资产。

包括：

家具：

-   沙发
-   桌椅
-   床
-   灯具

装饰：

-   植物
-   壁画
-   摆件

输出：

    sofa.glb
    table.glb
    lamp.glb

注意：

混元3D更适合作为资产生成器，而不是空间规划大脑。

------------------------------------------------------------------------

# 6. 渲染与交互层

## Web端

技术：

-   Three.js
-   WebGPU
-   WebXR

功能：

-   在线VR看房
-   第一视角漫游
-   家具替换
-   风格切换

## 高质量版本

技术：

-   Unreal Engine
-   Twinmotion

用于：

-   房地产营销
-   高端设计展示

------------------------------------------------------------------------

# 7. 用户交互流程

## Step 1

上传：

-   CAD
-   户型图
-   照片

## Step 2

AI分析：

生成：

-   房间结构
-   面积
-   动线
-   风格建议

## Step 3

AI设计：

用户输入：

"改成现代奶油风"

系统自动：

-   调整材质
-   更换家具
-   修改灯光

## Step 4

视觉预演：

GPT Image 2根据已批准的空间设计生成：

-   效果图
-   风格对比图
-   材质灯光预览

用户确认视觉方向后，系统才进入正式3D工程和VR生成。

## Step 5

生成：

-   VR链接
-   3D模型
-   装修方案

------------------------------------------------------------------------

# 8. 为什么采用多模型组合

单模型无法同时做到：

-   空间理解
-   设计推理
-   效果图与视觉方案生成
-   代码生成
-   高质量建模

因此采用：

## GPT-5.6 Sol

负责：

空间理解、设计推理和Spatial JSON生成。

## GPT Image 2

负责：

基于已批准设计生成效果图、风格对比和材质灯光预演。

不负责：

空间尺寸、拓扑、碰撞、动线和施工判断。

## Kimi K3

负责：

AI工程师角色。

## 混元3D

负责：

3D资产生产。

## Three.js / Unreal

负责：

最终体验。

------------------------------------------------------------------------

# 9. 商业应用场景

## 房地产

输入：

户型图

输出：

VR样板间。

## 装修公司

快速生成：

设计方案。

## 家居电商

用户：

上传房间照片。

AI：

推荐家具，使用GPT Image 2生成视觉预演，并在方案确认后生成可交互3D效果。

## 建筑设计

辅助：

方案推演。

------------------------------------------------------------------------

# 10. 核心竞争壁垒

未来竞争重点不是：

"谁生成模型最快"。

而是：

## 空间智能

AI是否理解：

-   为什么这样布局
-   人如何使用空间
-   家具如何摆放
-   动线是否合理

最终目标：

> 从AI 3D生成，升级到AI空间设计师。
